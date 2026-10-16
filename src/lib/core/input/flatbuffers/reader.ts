import {
	int64FromParts,
	type ArrayNode,
	type DType,
	type Node,
	type ScalarValue
} from '../../model';
import {
	DTYPE_SIZE,
	type FieldDef,
	type FieldType,
	type Schema,
	type StructDef,
	type TableDef,
	type UnionDef
} from './schema';

/**
 * Schema-driven FlatBuffers reader: walks a binary using a parsed .fbs and
 * produces the neutral Node tree. Absent fields are omitted (as `flatc --json`
 * does); `[ubyte]` vectors become `bytes`, other scalar vectors are lazy arrays.
 */

const MAX_DEPTH = 128;
const decoder = new TextDecoder('utf-8');

function invalid(detail: string): Error {
	return new Error(
		`This doesn't look like a valid FlatBuffer for the selected schema (${detail}). ` +
			`Check that the schema matches the file.`
	);
}

class Reader {
	private dv: DataView;

	constructor(private bytes: Uint8Array) {
		this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	private u32(pos: number): number {
		return this.dv.getUint32(pos, true);
	}

	scalar(dtype: DType, pos: number): ScalarValue {
		const dv = this.dv;
		switch (dtype) {
			case 'bool':
				return dv.getUint8(pos) !== 0;
			case 'int8':
				return dv.getInt8(pos);
			case 'uint8':
				return dv.getUint8(pos);
			case 'int16':
				return dv.getInt16(pos, true);
			case 'uint16':
				return dv.getUint16(pos, true);
			case 'int32':
				return dv.getInt32(pos, true);
			case 'uint32':
				return dv.getUint32(pos, true);
			case 'int64':
				return int64FromParts(dv.getUint32(pos, true), dv.getInt32(pos + 4, true), false);
			case 'uint64':
				return int64FromParts(dv.getUint32(pos, true), dv.getUint32(pos + 4, true), true);
			case 'float32':
				return dv.getFloat32(pos, true);
			case 'float64':
				return dv.getFloat64(pos, true);
			default:
				throw invalid(`unsupported scalar type ${dtype}`);
		}
	}

	root(schema: Schema, rootName?: TableDef): Node {
		const def = rootName ?? schema.rootType;
		if (!def) {
			throw new Error('The schema has no root_type, so the root table is unknown.');
		}
		if (this.bytes.length < 8) throw invalid('file is too small');
		const ident = schema.fileIdentifier;
		if (ident) {
			const found = String.fromCharCode(...this.bytes.subarray(4, 8));
			// Only complain if the file clearly carries a different identifier.
			if (found !== ident && /^[\x20-\x7e]{4}$/.test(found)) {
				throw new Error(
					`File identifier "${found}" doesn't match the schema's "${ident}". Is this the right schema?`
				);
			}
		}
		return this.table(def, this.u32(0), 0);
	}

	private table(def: TableDef, pos: number, depth: number): Node {
		if (depth > MAX_DEPTH) throw invalid('nesting is too deep');
		const dv = this.dv;
		const vtable = pos - dv.getInt32(pos, true);
		const vtableSize = dv.getUint16(vtable, true);
		/** In-table position of the field in `slot`, or -1 when absent. */
		const at = (slot: number): number => {
			const o = 4 + 2 * slot;
			if (slot < 0 || o + 2 > vtableSize) return -1;
			const off = dv.getUint16(vtable + o, true);
			return off === 0 ? -1 : pos + off;
		};

		const entries: [string, Node][] = [];
		for (const f of def.fields) {
			if (f.deprecated) continue;
			const fpos = at(f.slot);
			if (fpos < 0) continue;
			const t = f.type;
			if (t.kind === 'union') {
				this.union(f, t.def, fpos, at(f.typeSlot), depth, entries);
			} else if (t.kind === 'vector' && t.elem.kind === 'union') {
				this.unionVector(f, t.elem.def, fpos, at(f.typeSlot), depth, entries);
			} else {
				entries.push([f.name, this.value(t, fpos, depth)]);
			}
		}
		return { k: 'obj', entries };
	}

	/** A field's value; `pos` is where it sits in the table (inline value or offset). */
	private value(t: FieldType, pos: number, depth: number): Node {
		switch (t.kind) {
			case 'scalar':
				return { k: 'scalar', dtype: t.dtype, v: this.scalar(t.dtype, pos) };
			case 'enum':
				return this.enumValue(t, pos);
			case 'string':
				return { k: 'str', v: this.string(pos + this.u32(pos)) };
			case 'table':
				return this.table(t.def, pos + this.u32(pos), depth + 1);
			case 'struct':
				return this.struct(t.def, pos);
			case 'vector':
				return this.vector(t.elem, pos + this.u32(pos), depth);
			default:
				throw invalid(`unexpected ${t.kind} field`);
		}
	}

	private enumValue(t: Extract<FieldType, { kind: 'enum' }>, pos: number): Node {
		const raw = this.scalar(t.def.underlying, pos) as number | bigint;
		const name = t.def.byValue.get(BigInt(raw));
		return { k: 'enum', name: name ?? String(raw), num: Number(raw) };
	}

	private string(pos: number): string {
		const len = this.u32(pos);
		if (pos + 4 + len > this.bytes.length) throw invalid('string runs past the end of the file');
		return decoder.decode(this.bytes.subarray(pos + 4, pos + 4 + len));
	}

	private struct(def: StructDef, pos: number): Node {
		const entries: [string, Node][] = [];
		for (const f of def.fields) {
			if (f.deprecated) continue;
			entries.push([f.name, this.inline(f.type, pos + f.offset)]);
		}
		return { k: 'obj', entries };
	}

	/** Values stored inline in a struct. */
	private inline(t: FieldType, pos: number): Node {
		switch (t.kind) {
			case 'scalar':
				return { k: 'scalar', dtype: t.dtype, v: this.scalar(t.dtype, pos) };
			case 'enum':
				return this.enumValue(t, pos);
			case 'struct':
				return this.struct(t.def, pos);
			case 'array': {
				if (t.elem.kind === 'scalar') return this.scalarArray(t.elem.dtype, pos, t.length);
				const size = this.inlineSize(t.elem);
				const items: Node[] = [];
				for (let i = 0; i < t.length; i++) items.push(this.inline(t.elem, pos + i * size));
				return { k: 'list', items };
			}
			default:
				throw invalid(`unexpected ${t.kind} inside a struct`);
		}
	}

	private inlineSize(t: FieldType): number {
		switch (t.kind) {
			case 'scalar':
				return DTYPE_SIZE[t.dtype];
			case 'enum':
				return DTYPE_SIZE[t.def.underlying];
			case 'struct':
				return t.def.size;
			default:
				throw invalid(`unexpected ${t.kind} inside a struct`);
		}
	}

	private scalarArray(dtype: DType, base: number, length: number): ArrayNode {
		if (base + length * DTYPE_SIZE[dtype] > this.bytes.length) {
			throw invalid('vector runs past the end of the file');
		}
		const size = DTYPE_SIZE[dtype];
		return { k: 'array', dtype, length, get: (i) => this.scalar(dtype, base + i * size) };
	}

	private vector(elem: FieldType, vpos: number, depth: number): Node {
		const length = this.u32(vpos);
		const base = vpos + 4;
		switch (elem.kind) {
			case 'scalar':
				if (elem.dtype === 'uint8') {
					if (base + length > this.bytes.length)
						throw invalid('vector runs past the end of the file');
					return { k: 'bytes', v: this.bytes.subarray(base, base + length) };
				}
				return this.scalarArray(elem.dtype, base, length);
			case 'enum': {
				const size = DTYPE_SIZE[elem.def.underlying];
				if (base + length * size > this.bytes.length)
					throw invalid('vector runs past the end of the file');
				const items: Node[] = [];
				for (let i = 0; i < length; i++) items.push(this.enumValue(elem, base + i * size));
				return { k: 'list', items };
			}
			case 'string': {
				if (base + length * 4 > this.bytes.length)
					throw invalid('vector runs past the end of the file');
				const items: Node[] = [];
				for (let i = 0; i < length; i++) {
					const p = base + 4 * i;
					items.push({ k: 'str', v: this.string(p + this.u32(p)) });
				}
				return { k: 'list', items };
			}
			case 'table': {
				if (base + length * 4 > this.bytes.length)
					throw invalid('vector runs past the end of the file');
				const items: Node[] = [];
				for (let i = 0; i < length; i++) {
					const p = base + 4 * i;
					items.push(this.table(elem.def, p + this.u32(p), depth + 1));
				}
				return { k: 'list', items };
			}
			case 'struct': {
				if (base + length * elem.def.size > this.bytes.length) {
					throw invalid('vector runs past the end of the file');
				}
				const items: Node[] = [];
				for (let i = 0; i < length; i++)
					items.push(this.struct(elem.def, base + i * elem.def.size));
				return { k: 'list', items };
			}
			default:
				throw invalid(`unsupported vector element ${elem.kind}`);
		}
	}

	private unionMemberNode(def: UnionDef, typeValue: number, pos: number, depth: number): Node {
		const member = def.members.find((m) => m.value === typeValue);
		if (!member) throw invalid(`union "${def.name}" has unknown type ${typeValue}`);
		switch (member.type.kind) {
			case 'table':
				return this.table(member.type.def, pos + this.u32(pos), depth + 1);
			case 'string':
				return { k: 'str', v: this.string(pos + this.u32(pos)) };
			case 'struct':
				return this.struct(member.type.def, pos + this.u32(pos));
		}
	}

	private union(
		f: FieldDef,
		def: UnionDef,
		valuePos: number,
		typePos: number,
		depth: number,
		out: [string, Node][]
	): void {
		const typeValue = typePos < 0 ? 0 : this.dv.getUint8(typePos);
		if (typeValue === 0) return; // NONE
		const member = def.members.find((m) => m.value === typeValue);
		out.push([
			`${f.name}_type`,
			{ k: 'enum', name: member?.name ?? String(typeValue), num: typeValue }
		]);
		out.push([f.name, this.unionMemberNode(def, typeValue, valuePos, depth)]);
	}

	private unionVector(
		f: FieldDef,
		def: UnionDef,
		valuePos: number,
		typePos: number,
		depth: number,
		out: [string, Node][]
	): void {
		if (typePos < 0) throw invalid(`union vector "${f.name}" has no type vector`);
		const types = typePos + this.u32(typePos);
		const values = valuePos + this.u32(valuePos);
		const length = this.u32(values);
		if (this.u32(types) !== length) throw invalid(`union vector "${f.name}" lengths differ`);
		const typeNodes: Node[] = [];
		const valueNodes: Node[] = [];
		for (let i = 0; i < length; i++) {
			const tv = this.dv.getUint8(types + 4 + i);
			const member = def.members.find((m) => m.value === tv);
			typeNodes.push({
				k: 'enum',
				name: tv === 0 ? 'NONE' : (member?.name ?? String(tv)),
				num: tv
			});
			valueNodes.push(
				tv === 0
					? { k: 'enum', name: 'NONE', num: 0 }
					: this.unionMemberNode(def, tv, values + 4 + 4 * i, depth)
			);
		}
		out.push([`${f.name}_type`, { k: 'list', items: typeNodes }]);
		out.push([f.name, { k: 'list', items: valueNodes }]);
	}
}

/** Read `bytes` as the schema's root type (or `rootType` when given). */
export function readFlatBuffer(schema: Schema, bytes: Uint8Array, rootType?: TableDef): Node {
	try {
		return new Reader(bytes).root(schema, rootType);
	} catch (e) {
		if (e instanceof RangeError) throw invalid('read past the end of the file');
		throw e;
	}
}
