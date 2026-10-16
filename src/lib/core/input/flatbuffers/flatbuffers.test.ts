import * as flatbuffers from 'flatbuffers';
import { describe, expect, it } from 'vitest';
import { jsonFormat } from '../../output/json';
import { readFlatBuffer } from './reader';
import { parseSchema } from './schema';

/**
 * Buffers here are built with the official `flatbuffers` JS Builder, so these
 * tests check our reader against an independent writer.
 */

const FBS = `
// A comment
namespace game.core;

enum Color : byte { Red = 0, Green, Blue = 5 }
enum Flags : ubyte (bit_flags) { A, B, C }

struct Vec3 { x: float; y: float; z: float; }
struct Pair { a: ubyte; b: long; }

table Weapon { name: string; damage: short = 10; }
table Extra { note: string; }

union Equipment { Weapon, Extra, Named: Weapon }

table Monster (root) {
  pos: Vec3;
  mana: short = 150;
  hp: short = 100;
  name: string;
  inventory: [ubyte];
  color: Color = Green;
  flags: Flags;
  weapons: [Weapon];
  names: [string];
  scores: [float];
  big: ulong;
  neg: long;
  ratio: double;
  alive: bool;
  old: int (deprecated);
  equipped: Equipment;
  pairs: [Pair];
  colors: [Color];
  bag: [Equipment];
}

root_type Monster;
file_identifier "MONS";
`;

describe('parseSchema', () => {
	it('parses definitions and layouts', () => {
		const s = parseSchema([{ name: 'game.fbs', text: FBS }]);
		expect([...s.tables.keys()]).toEqual([
			'game.core.Weapon',
			'game.core.Extra',
			'game.core.Monster'
		]);
		expect(s.rootType?.name).toBe('game.core.Monster');
		expect(s.fileIdentifier).toBe('MONS');

		const pair = s.structs.get('game.core.Pair')!;
		expect(pair.fields.map((f) => [f.name, f.offset])).toEqual([
			['a', 0],
			['b', 8]
		]);
		expect(pair.size).toBe(16);
		expect(s.structs.get('game.core.Vec3')!.size).toBe(12);

		const color = s.enums.get('game.core.Color')!;
		expect(color.values.map((v) => v.value)).toEqual([0n, 1n, 5n]);
		expect(s.enums.get('game.core.Flags')!.values.map((v) => v.value)).toEqual([1n, 2n, 4n]);
		expect(s.unions.get('game.core.Equipment')!.members.map((m) => [m.name, m.value])).toEqual([
			['Weapon', 1],
			['Extra', 2],
			['Named', 3]
		]);
	});

	it('assigns two slots to unions', () => {
		const s = parseSchema([{ name: 'game.fbs', text: FBS }]);
		const monster = s.tables.get('game.core.Monster')!;
		const eq = monster.fields.find((f) => f.name === 'equipped')!;
		const pairs = monster.fields.find((f) => f.name === 'pairs')!;
		expect(eq.slot).toBe(eq.typeSlot + 1);
		expect(pairs.slot).toBe(eq.slot + 1);
	});

	it('honours explicit ids', () => {
		const s = parseSchema([
			{ name: 'a.fbs', text: 'table T { b: int (id: 1); a: int (id: 0); } root_type T;' }
		]);
		const t = s.tables.get('T')!;
		expect(t.fields.map((f) => [f.name, f.slot])).toEqual([
			['b', 1],
			['a', 0]
		]);
	});

	it('resolves names across included files and namespaces', () => {
		const s = parseSchema([
			{
				name: 'main.fbs',
				text: 'include "dep.fbs"; namespace a.b; table M { d: x.D; } root_type M;'
			},
			{ name: 'dir/dep.fbs', text: 'namespace x; table D { v: int; }' }
		]);
		expect(s.rootType?.name).toBe('a.b.M');
		expect(s.tables.has('x.D')).toBe(true);
	});

	it('reports helpful errors', () => {
		expect(() => parseSchema([{ name: 'a.fbs', text: 'include "missing.fbs";' }])).toThrow(
			/missing\.fbs.*wasn't provided/
		);
		expect(() => parseSchema([{ name: 'a.fbs', text: 'table T { x: Nope; }' }])).toThrow(
			/a\.fbs:1.*unknown type "Nope"/
		);
		expect(() => parseSchema([{ name: 'a.fbs', text: 'table T { x int; }' }])).toThrow(/a\.fbs:1/);
		expect(() => parseSchema([{ name: 'a.fbs', text: 'table T {}\ntable T {}' }])).toThrow(
			/more than once/
		);
	});
});

function buildMonster(): Uint8Array {
	const b = new flatbuffers.Builder(256);
	const sword = b.createString('sword');
	const bow = b.createString('bow');
	// Weapon tables
	b.startObject(2);
	b.addFieldOffset(0, sword, 0);
	b.addFieldInt16(1, 42, 10);
	const w1 = b.endObject();
	b.startObject(2);
	b.addFieldOffset(0, bow, 0);
	const w2 = b.endObject(); // damage left at default
	const weaponsVec = (() => {
		b.startVector(4, 2, 4);
		b.addOffset(w2);
		b.addOffset(w1);
		return b.endVector();
	})();
	const name = b.createString('Orc ü');
	const inv = b.createByteVector(new Uint8Array([1, 2, 3, 255]));
	const n1 = b.createString('a');
	const n2 = b.createString('b');
	const namesVec = (() => {
		b.startVector(4, 2, 4);
		b.addOffset(n2);
		b.addOffset(n1);
		return b.endVector();
	})();
	const scoresVec = (() => {
		b.startVector(4, 3, 4);
		b.addFloat32(3.5);
		b.addFloat32(2.5);
		b.addFloat32(1.5);
		return b.endVector();
	})();
	const pairsVec = (() => {
		b.startVector(16, 2, 8);
		// structs are written back to front: b (long) then a (ubyte) with padding
		for (const [a, big] of [
			[2, 200n],
			[1, 100n]
		] as const) {
			b.prep(8, 16);
			b.writeInt64(big);
			b.pad(7);
			b.writeInt8(a);
		}
		return b.endVector();
	})();
	const colorsVec = (() => {
		b.startVector(1, 2, 1);
		b.addInt8(5);
		b.addInt8(0);
		return b.endVector();
	})();
	// Union value: an Extra table
	const noteStr = b.createString('careful');
	b.startObject(1);
	b.addFieldOffset(0, noteStr, 0);
	const extra = b.endObject();

	// bag: vector of unions (types vector + values vector)
	const bagTypes = b.createByteVector(new Uint8Array([2, 1]));
	const bagValues = (() => {
		b.startVector(4, 2, 4);
		b.addOffset(w1);
		b.addOffset(extra);
		return b.endVector();
	})();

	// Monster
	b.startObject(30);
	// Slots follow declaration order with unions taking two: pos0 mana1 hp2 name3 inventory4 color5
	// flags6 weapons7 names8 scores9 big10 neg11 ratio12 alive13 old14 equipped_type15 equipped16
	// pairs17 colors18 bag_type19 bag20
	b.addFieldStruct(
		0,
		(() => {
			b.prep(4, 12);
			b.writeFloat32(3);
			b.writeFloat32(2);
			b.writeFloat32(1);
			return b.offset();
		})(),
		0
	);
	b.addFieldInt16(1, 150, 150); // default: omitted
	b.addFieldInt16(2, 80, 100);
	b.addFieldOffset(3, name, 0);
	b.addFieldOffset(4, inv, 0);
	b.addFieldInt8(5, 5, 1);
	b.addFieldInt8(6, 5, 0); // flags: A|C -> 5, not an exact enum value
	b.addFieldOffset(7, weaponsVec, 0);
	b.addFieldOffset(8, namesVec, 0);
	b.addFieldOffset(9, scoresVec, 0);
	b.addFieldInt64(10, 18446744073709551615n, 0n);
	b.addFieldInt64(11, -9223372036854775808n, 0n);
	b.addFieldFloat64(12, 0.1, 0);
	b.addFieldInt8(13, 1, 0);
	b.addFieldInt32(14, 7, 0); // deprecated
	b.addFieldInt8(15, 2, 0);
	b.addFieldOffset(16, extra, 0);
	b.addFieldOffset(17, pairsVec, 0);
	b.addFieldOffset(18, colorsVec, 0);
	b.addFieldOffset(19, bagTypes, 0);
	b.addFieldOffset(20, bagValues, 0);
	const root = b.endObject();
	b.finish(root, 'MONS');
	return b.asUint8Array();
}

function toJson(bytes: Uint8Array) {
	const schema = parseSchema([{ name: 'game.fbs', text: FBS }]);
	const node = readFlatBuffer(schema, bytes);
	return JSON.parse(
		[...jsonFormat.serialize({ root: node, bytes }, { truncateTo: null })].join('')
	);
}

describe('readFlatBuffer', () => {
	const out = toJson(buildMonster());

	it('reads scalars, strings and omits absent/default/deprecated fields', () => {
		expect(out.hp).toBe(80);
		expect(out.mana).toBeUndefined();
		expect(out.old).toBeUndefined();
		expect(out.name).toBe('Orc ü');
		expect(out.alive).toBe(true);
		expect(out.ratio).toBe(0.1);
		expect(out.big).toBe('18446744073709551615');
		expect(out.neg).toBe('-9223372036854775808');
	});

	it('reads enums by name', () => {
		expect(out.color).toBe('Blue');
		expect(out.flags).toBe('5'); // no exact name for a flag combination
		expect(out.colors).toEqual(['Red', 'Blue']);
	});

	it('reads structs, struct vectors and ubyte vectors', () => {
		expect(out.pos).toEqual({ x: 1, y: 2, z: 3 });
		expect(out.pairs).toEqual([
			{ a: 1, b: '100' },
			{ a: 2, b: '200' }
		]);
		expect(Buffer.from(out.inventory, 'base64')).toEqual(Buffer.from([1, 2, 3, 255]));
	});

	it('reads vectors of tables, strings and scalars', () => {
		expect(out.weapons).toEqual([{ name: 'sword', damage: 42 }, { name: 'bow' }]);
		expect(out.names).toEqual(['a', 'b']);
		expect(out.scores).toEqual([1.5, 2.5, 3.5]);
	});

	it('reads unions and union vectors', () => {
		expect(out.equipped_type).toBe('Extra');
		expect(out.equipped).toEqual({ note: 'careful' });
		expect(out.bag_type).toEqual(['Extra', 'Weapon']);
		expect(out.bag).toEqual([{ note: 'careful' }, { name: 'sword', damage: 42 }]);
	});

	it('rejects a mismatched file identifier', () => {
		const bytes = buildMonster();
		bytes.set(new TextEncoder().encode('XXXX'), 4);
		expect(() => toJson(bytes)).toThrow(/identifier "XXXX".*"MONS"/);
	});

	it('fails cleanly on garbage and truncation', () => {
		const bytes = buildMonster();
		expect(() => toJson(bytes.subarray(0, 40))).toThrow(/valid FlatBuffer/);
		const junk = new Uint8Array(64).fill(255);
		expect(() => toJson(junk)).toThrow(/valid FlatBuffer/);
	});

	it('requires a root_type', () => {
		const schema = parseSchema([{ name: 'a.fbs', text: 'table T { x: int; }' }]);
		expect(() => readFlatBuffer(schema, new Uint8Array(16))).toThrow(/root_type/);
	});
});
