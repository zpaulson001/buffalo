import type { DType } from '../../model';

/**
 * A small FlatBuffers schema (.fbs) parser. It understands what is needed to
 * *read* a binary: namespaces, includes, tables, structs, enums (incl.
 * bit_flags), unions, root_type, file_identifier and the `id`, `deprecated` and
 * `force_align` attributes. RPC services and the object-API attributes are
 * skipped.
 */

export interface SchemaSource {
	name: string;
	text: string;
}

export const DTYPE_SIZE: Record<DType, number> = {
	bool: 1,
	int8: 1,
	uint8: 1,
	int16: 2,
	uint16: 2,
	int32: 4,
	uint32: 4,
	int64: 8,
	uint64: 8,
	float16: 2,
	bfloat16: 2,
	float32: 4,
	float64: 8
};

const SCALAR_NAMES: Record<string, DType> = {
	bool: 'bool',
	byte: 'int8',
	int8: 'int8',
	ubyte: 'uint8',
	uint8: 'uint8',
	short: 'int16',
	int16: 'int16',
	ushort: 'uint16',
	uint16: 'uint16',
	int: 'int32',
	int32: 'int32',
	uint: 'uint32',
	uint32: 'uint32',
	long: 'int64',
	int64: 'int64',
	ulong: 'uint64',
	uint64: 'uint64',
	float: 'float32',
	float32: 'float32',
	double: 'float64',
	float64: 'float64'
};

// ---------------------------------------------------------------- schema model

export type FieldType =
	| { kind: 'scalar'; dtype: DType }
	| { kind: 'string' }
	| { kind: 'enum'; def: EnumDef }
	| { kind: 'table'; def: TableDef }
	| { kind: 'struct'; def: StructDef }
	| { kind: 'union'; def: UnionDef }
	| { kind: 'vector'; elem: FieldType }
	/** Fixed-length array; only allowed inside structs. */
	| { kind: 'array'; elem: FieldType; length: number };

export interface FieldDef {
	name: string;
	type: FieldType;
	deprecated: boolean;
	/** Raw default value text, if one was given. Absent fields are omitted from output. */
	defaultValue?: string;
	/** Tables: vtable slot of the field (of the union's value for unions). */
	slot: number;
	/** Tables: vtable slot of the hidden `<name>_type` field (unions and vectors of unions). */
	typeSlot: number;
	/** Structs: byte offset within the struct. */
	offset: number;
}

export interface TableDef {
	name: string;
	fields: FieldDef[];
}

export interface StructDef {
	name: string;
	fields: FieldDef[];
	size: number;
	align: number;
}

export interface EnumDef {
	name: string;
	underlying: DType;
	values: { name: string; value: bigint }[];
	byValue: Map<bigint, string>;
}

export interface UnionMember {
	name: string;
	/** Value of the hidden type field (1-based unless explicit). */
	value: number;
	type: { kind: 'table'; def: TableDef } | { kind: 'struct'; def: StructDef } | { kind: 'string' };
}

export interface UnionDef {
	name: string;
	members: UnionMember[];
}

export interface Schema {
	tables: Map<string, TableDef>;
	structs: Map<string, StructDef>;
	enums: Map<string, EnumDef>;
	unions: Map<string, UnionDef>;
	rootType?: TableDef;
	fileIdentifier?: string;
}

// ------------------------------------------------------------------- tokenizer

interface Tok {
	t: 'id' | 'num' | 'str' | 'p' | 'eof';
	v: string;
	line: number;
}

const NUMBER = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;
const IDENT = /^[+-]?[A-Za-z_][A-Za-z0-9_.]*/;

function tokenize(src: string, file: string): Tok[] {
	const toks: Tok[] = [];
	let i = 0;
	let line = 1;
	const fail = (msg: string): never => {
		throw new Error(`${file}:${line}: ${msg}`);
	};
	while (i < src.length) {
		const c = src[i];
		if (c === '\n') {
			line++;
			i++;
		} else if (c === ' ' || c === '\t' || c === '\r') {
			i++;
		} else if (src.startsWith('//', i)) {
			while (i < src.length && src[i] !== '\n') i++;
		} else if (src.startsWith('/*', i)) {
			const end = src.indexOf('*/', i + 2);
			if (end < 0) fail('unterminated comment');
			for (const ch of src.slice(i, end)) if (ch === '\n') line++;
			i = end + 2;
		} else if (c === '"') {
			let s = '';
			i++;
			while (i < src.length && src[i] !== '"') {
				if (src[i] === '\\' && i + 1 < src.length) {
					i++;
					s += src[i] === 'n' ? '\n' : src[i] === 't' ? '\t' : src[i];
				} else {
					s += src[i];
				}
				i++;
			}
			if (i >= src.length) fail('unterminated string');
			i++;
			toks.push({ t: 'str', v: s, line });
		} else if ('{}()[]:;,='.includes(c)) {
			toks.push({ t: 'p', v: c, line });
			i++;
		} else {
			const rest = src.slice(i, i + 64);
			const num = NUMBER.exec(rest);
			if (num) {
				toks.push({ t: 'num', v: num[0], line });
				i += num[0].length;
				continue;
			}
			const id = IDENT.exec(rest);
			if (!id) fail(`unexpected character "${c}"`);
			toks.push({ t: 'id', v: id![0], line });
			i += id![0].length;
		}
	}
	toks.push({ t: 'eof', v: '', line });
	return toks;
}

// ---------------------------------------------------------------------- parser

type TypeSrc =
	| { k: 'name'; name: string }
	| { k: 'vector'; elem: TypeSrc }
	| { k: 'array'; elem: TypeSrc; length: number };

type Attrs = Map<string, string>;

interface RawField {
	name: string;
	type: TypeSrc;
	defaultValue?: string;
	attrs: Attrs;
	line: number;
}

interface RawTable {
	kind: 'table' | 'struct';
	name: string;
	ns: string;
	fields: RawField[];
	attrs: Attrs;
	line: number;
}

interface RawEnum {
	name: string;
	ns: string;
	underlying: string;
	values: { name: string; value?: string }[];
	attrs: Attrs;
	line: number;
}

interface RawUnion {
	name: string;
	ns: string;
	members: { name: string; type: string; value?: string }[];
	line: number;
}

interface RawFile {
	name: string;
	includes: string[];
	tables: RawTable[];
	enums: RawEnum[];
	unions: RawUnion[];
	rootType?: string;
	rootNs: string;
	fileIdentifier?: string;
}

class Parser {
	private i = 0;
	private toks: Tok[];

	constructor(
		private file: string,
		src: string
	) {
		this.toks = tokenize(src, file);
	}

	private peek(): Tok {
		return this.toks[this.i];
	}

	private next(): Tok {
		return this.toks[this.i++];
	}

	private fail(msg: string, tok = this.peek()): never {
		throw new Error(`${this.file}:${tok.line}: ${msg}`);
	}

	private isP(v: string): boolean {
		const t = this.peek();
		return t.t === 'p' && t.v === v;
	}

	private acceptP(v: string): boolean {
		if (!this.isP(v)) return false;
		this.i++;
		return true;
	}

	private expectP(v: string): void {
		if (!this.acceptP(v)) {
			const t = this.peek();
			this.fail(`expected "${v}" but found ${t.t === 'eof' ? 'end of file' : `"${t.v}"`}`);
		}
	}

	private expectId(what: string): string {
		const t = this.next();
		if (t.t !== 'id') this.fail(`expected ${what} but found "${t.v}"`, t);
		return t.v;
	}

	private expectStr(what: string): string {
		const t = this.next();
		if (t.t !== 'str') this.fail(`expected ${what} (a quoted string) but found "${t.v}"`, t);
		return t.v;
	}

	parseFile(): RawFile {
		const file: RawFile = {
			name: this.file,
			includes: [],
			tables: [],
			enums: [],
			unions: [],
			rootNs: ''
		};
		let ns = '';
		while (this.peek().t !== 'eof') {
			const kw = this.next();
			if (kw.t !== 'id') this.fail(`unexpected "${kw.v}"`, kw);
			switch (kw.v) {
				case 'include':
					file.includes.push(this.expectStr('an include path'));
					this.expectP(';');
					break;
				case 'native_include':
					this.expectStr('a path');
					this.expectP(';');
					break;
				case 'namespace':
					ns = this.expectId('a namespace');
					this.expectP(';');
					break;
				case 'attribute':
					this.next();
					this.expectP(';');
					break;
				case 'root_type':
					file.rootType = this.expectId('a type name');
					file.rootNs = ns;
					this.expectP(';');
					break;
				case 'file_identifier':
					file.fileIdentifier = this.expectStr('a file identifier');
					this.expectP(';');
					break;
				case 'file_extension':
					this.expectStr('a file extension');
					this.expectP(';');
					break;
				case 'table':
				case 'struct':
					file.tables.push(this.parseTable(kw.v, ns, kw.line));
					break;
				case 'enum':
					file.enums.push(this.parseEnum(ns, kw.line));
					break;
				case 'union':
					file.unions.push(this.parseUnion(ns, kw.line));
					break;
				case 'rpc_service':
					this.expectId('a service name');
					this.skipBlock();
					break;
				default:
					this.fail(`unexpected "${kw.v}"`, kw);
			}
		}
		return file;
	}

	private skipBlock(): void {
		this.expectP('{');
		let depth = 1;
		while (depth > 0) {
			const t = this.next();
			if (t.t === 'eof') this.fail('unterminated block');
			if (t.t === 'p' && t.v === '{') depth++;
			if (t.t === 'p' && t.v === '}') depth--;
		}
	}

	private parseAttrs(): Attrs {
		const attrs: Attrs = new Map();
		if (!this.acceptP('(')) return attrs;
		while (!this.acceptP(')')) {
			const key = this.expectId('an attribute name');
			let value = '';
			if (this.acceptP(':')) value = this.next().v;
			attrs.set(key, value);
			if (!this.isP(')')) this.expectP(',');
		}
		return attrs;
	}

	private parseType(): TypeSrc {
		if (this.acceptP('[')) {
			const elem = this.parseType();
			if (this.acceptP(':')) {
				const n = this.next();
				if (n.t !== 'num') this.fail('expected an array length', n);
				this.expectP(']');
				return { k: 'array', elem, length: Number(n.v) };
			}
			this.expectP(']');
			return { k: 'vector', elem };
		}
		return { k: 'name', name: this.expectId('a type') };
	}

	private parseTable(kind: 'table' | 'struct', ns: string, line: number): RawTable {
		const name = this.expectId('a name');
		const attrs = this.parseAttrs();
		this.expectP('{');
		const fields: RawField[] = [];
		while (!this.acceptP('}')) {
			const ft = this.peek();
			const fname = this.expectId('a field name');
			this.expectP(':');
			const type = this.parseType();
			let defaultValue: string | undefined;
			if (this.acceptP('=')) defaultValue = this.next().v;
			const fattrs = this.parseAttrs();
			this.expectP(';');
			fields.push({ name: fname, type, defaultValue, attrs: fattrs, line: ft.line });
		}
		return { kind, name, ns, fields, attrs, line };
	}

	private parseEnum(ns: string, line: number): RawEnum {
		const name = this.expectId('an enum name');
		this.expectP(':');
		const underlying = this.expectId('an underlying type');
		const attrs = this.parseAttrs();
		this.expectP('{');
		const values: RawEnum['values'] = [];
		while (!this.acceptP('}')) {
			const vname = this.expectId('an enum value name');
			let value: string | undefined;
			if (this.acceptP('=')) value = this.next().v;
			this.parseAttrs();
			values.push({ name: vname, value });
			if (!this.isP('}')) this.expectP(',');
		}
		return { name, ns, underlying, values, attrs, line };
	}

	private parseUnion(ns: string, line: number): RawUnion {
		const name = this.expectId('a union name');
		this.parseAttrs();
		this.expectP('{');
		const members: RawUnion['members'] = [];
		while (!this.acceptP('}')) {
			let mname = this.expectId('a union member');
			let type = mname;
			if (this.acceptP(':')) type = this.expectId('a member type');
			else mname = mname.split('.').pop()!;
			this.parseAttrs(); // e.g. `Member (deprecated)`: the member still occupies its type value
			let value: string | undefined;
			if (this.acceptP('=')) value = this.next().v;
			this.parseAttrs();
			members.push({ name: mname, type, value });
			if (!this.isP('}')) this.expectP(',');
		}
		return { name, ns, members, line };
	}
}

// ------------------------------------------------------------------ resolution

function basename(path: string): string {
	return path.split(/[\\/]/).pop()!;
}

function qualify(ns: string, name: string): string {
	return ns ? `${ns}.${name}` : name;
}

function alignUp(n: number, a: number): number {
	return Math.ceil(n / a) * a;
}

/** Parse a set of .fbs files (a main schema plus the files it includes). */
export function parseSchema(sources: SchemaSource[]): Schema {
	if (sources.length === 0) throw new Error('No schema files were provided.');
	const files = sources.map((s) => new Parser(s.name, s.text).parseFile());

	// Every include must be among the provided files.
	const provided = new Set(sources.map((s) => basename(s.name)));
	const included = new Set<string>();
	for (const f of files) {
		for (const inc of f.includes) {
			if (!provided.has(basename(inc))) {
				throw new Error(
					`${f.name}: includes "${inc}", which wasn't provided. Add it to the dropped files.`
				);
			}
			included.add(basename(inc));
		}
	}

	const schema: Schema = {
		tables: new Map(),
		structs: new Map(),
		enums: new Map(),
		unions: new Map()
	};

	const has = (q: string) =>
		schema.tables.has(q) || schema.structs.has(q) || schema.enums.has(q) || schema.unions.has(q);
	const declare = (q: string, where: string) => {
		if (has(q)) throw new Error(`${where}: "${q}" is defined more than once.`);
	};

	// Pass 1: create empty definitions so types can reference each other freely.
	const rawTables: [RawTable, TableDef | StructDef, string][] = [];
	const rawEnums: [RawEnum, EnumDef, string][] = [];
	const rawUnions: [RawUnion, UnionDef, string][] = [];
	for (const f of files) {
		for (const t of f.tables) {
			const q = qualify(t.ns, t.name);
			declare(q, `${f.name}:${t.line}`);
			if (t.kind === 'table') {
				const def: TableDef = { name: q, fields: [] };
				schema.tables.set(q, def);
				rawTables.push([t, def, f.name]);
			} else {
				const def: StructDef = { name: q, fields: [], size: 0, align: 1 };
				schema.structs.set(q, def);
				rawTables.push([t, def, f.name]);
			}
		}
		for (const e of f.enums) {
			const q = qualify(e.ns, e.name);
			declare(q, `${f.name}:${e.line}`);
			const underlying = SCALAR_NAMES[e.underlying];
			if (!underlying)
				throw new Error(`${f.name}:${e.line}: enum "${e.name}" has bad type "${e.underlying}".`);
			const def: EnumDef = { name: q, underlying, values: [], byValue: new Map() };
			schema.enums.set(q, def);
			rawEnums.push([e, def, f.name]);
		}
		for (const u of f.unions) {
			const q = qualify(u.ns, u.name);
			declare(q, `${f.name}:${u.line}`);
			const def: UnionDef = { name: q, members: [] };
			schema.unions.set(q, def);
			rawUnions.push([u, def, f.name]);
		}
	}

	/** FlatBuffers name lookup: innermost namespace first, then each parent, then global. */
	function lookup(name: string, ns: string): string | undefined {
		const parts = ns ? ns.split('.') : [];
		for (let n = parts.length; n >= 0; n--) {
			const q = [...parts.slice(0, n), name].join('.');
			if (has(q)) return q;
		}
		return undefined;
	}

	function resolveType(src: TypeSrc, ns: string, where: string): FieldType {
		if (src.k === 'vector') {
			const elem = resolveType(src.elem, ns, where);
			if (elem.kind === 'vector' || elem.kind === 'array') {
				throw new Error(`${where}: nested vectors are not supported by FlatBuffers.`);
			}
			return { kind: 'vector', elem };
		}
		if (src.k === 'array') {
			return { kind: 'array', elem: resolveType(src.elem, ns, where), length: src.length };
		}
		const scalar = SCALAR_NAMES[src.name];
		if (scalar) return { kind: 'scalar', dtype: scalar };
		if (src.name === 'string') return { kind: 'string' };
		const q = lookup(src.name, ns);
		if (!q) throw new Error(`${where}: unknown type "${src.name}".`);
		if (schema.tables.has(q)) return { kind: 'table', def: schema.tables.get(q)! };
		if (schema.structs.has(q)) return { kind: 'struct', def: schema.structs.get(q)! };
		if (schema.enums.has(q)) return { kind: 'enum', def: schema.enums.get(q)! };
		return { kind: 'union', def: schema.unions.get(q)! };
	}

	// Pass 2a: enums.
	for (const [raw, def, file] of rawEnums) {
		const bitFlags = raw.attrs.has('bit_flags');
		let next = 0n;
		for (const v of raw.values) {
			let value = v.value !== undefined ? BigInt(v.value) : next;
			next = value + 1n;
			if (bitFlags) value = 1n << value;
			if (def.byValue.has(value)) {
				throw new Error(`${file}:${raw.line}: enum "${raw.name}" repeats value ${value}.`);
			}
			def.values.push({ name: v.name, value });
			def.byValue.set(value, v.name);
		}
	}

	// Pass 2b: unions.
	for (const [raw, def, file] of rawUnions) {
		let next = 1;
		for (const m of raw.members) {
			const where = `${file}:${raw.line}: union "${raw.name}"`;
			const value = m.value !== undefined ? Number(m.value) : next;
			next = value + 1;
			let type: UnionMember['type'];
			if (m.type === 'string') {
				type = { kind: 'string' };
			} else {
				const q = lookup(m.type, raw.ns);
				if (!q) throw new Error(`${where} has unknown member type "${m.type}".`);
				if (schema.tables.has(q)) type = { kind: 'table', def: schema.tables.get(q)! };
				else if (schema.structs.has(q)) type = { kind: 'struct', def: schema.structs.get(q)! };
				else throw new Error(`${where}: member "${m.name}" must be a table, struct or string.`);
			}
			def.members.push({ name: m.name, value, type });
		}
	}

	// Pass 2c: table and struct fields.
	for (const [raw, def, file] of rawTables) {
		for (const rf of raw.fields) {
			const where = `${file}:${rf.line}: ${raw.name}.${rf.name}`;
			const type = resolveType(rf.type, raw.ns, where);
			def.fields.push({
				name: rf.name,
				type,
				deprecated: rf.attrs.has('deprecated'),
				defaultValue: rf.defaultValue,
				slot: -1,
				typeSlot: -1,
				offset: 0
			});
		}
		if (raw.kind === 'table') assignSlots(def as TableDef, raw, file);
	}

	// Pass 3: struct layout (memoised, nested structs first).
	const laidOut = new Set<StructDef>();
	const laying = new Set<StructDef>();
	function layout(def: StructDef, raw: RawTable, file: string): void {
		if (laidOut.has(def)) return;
		if (laying.has(def))
			throw new Error(`${file}:${raw.line}: struct "${raw.name}" contains itself.`);
		laying.add(def);
		let offset = 0;
		let align = 1;
		for (const f of def.fields) {
			const [size, a] = sizeAlign(f.type, `${file}:${raw.line}: ${raw.name}.${f.name}`);
			offset = alignUp(offset, a);
			f.offset = offset;
			offset += size;
			align = Math.max(align, a);
		}
		const forced = raw.attrs.get('force_align');
		if (forced) align = Math.max(align, Number(forced));
		def.align = align;
		def.size = alignUp(offset, align);
		laying.delete(def);
		laidOut.add(def);
	}
	const rawByStruct = new Map<StructDef, [RawTable, string]>();
	for (const [raw, def, file] of rawTables) {
		if (raw.kind === 'struct') rawByStruct.set(def as StructDef, [raw, file]);
	}
	function sizeAlign(t: FieldType, where: string): [number, number] {
		switch (t.kind) {
			case 'scalar':
				return [DTYPE_SIZE[t.dtype], DTYPE_SIZE[t.dtype]];
			case 'enum':
				return [DTYPE_SIZE[t.def.underlying], DTYPE_SIZE[t.def.underlying]];
			case 'struct': {
				const [raw, file] = rawByStruct.get(t.def)!;
				layout(t.def, raw, file);
				return [t.def.size, t.def.align];
			}
			case 'array': {
				const [s, a] = sizeAlign(t.elem, where);
				return [s * t.length, a];
			}
			default:
				throw new Error(`${where}: structs may only contain scalars, enums, structs and arrays.`);
		}
	}
	for (const [def, [raw, file]] of rawByStruct) layout(def, raw, file);

	// Root type and file identifier.
	const roots = files.filter((f) => f.rootType && !included.has(basename(f.name)));
	const rootFile = roots[0] ?? files.find((f) => f.rootType);
	if (rootFile?.rootType) {
		const q = lookup(rootFile.rootType, rootFile.rootNs);
		if (!q || !schema.tables.has(q)) {
			throw new Error(`${rootFile.name}: root_type "${rootFile.rootType}" is not a table.`);
		}
		schema.rootType = schema.tables.get(q)!;
	}
	schema.fileIdentifier = (roots[0] ?? files.find((f) => f.fileIdentifier))?.fileIdentifier;
	return schema;
}

/**
 * Vtable slots: declaration order, or by `id` when ids are used. A union takes
 * two slots (hidden `_type` first, then the value); with explicit ids the type
 * slot is `id - 1`.
 */
function assignSlots(def: TableDef, raw: RawTable, file: string): void {
	const withIds = raw.fields.some((f) => f.attrs.has('id'));
	const order = def.fields.map((f, i) => ({ f, raw: raw.fields[i] }));
	if (withIds) {
		if (order.some((o) => !o.raw.attrs.has('id'))) {
			throw new Error(
				`${file}:${raw.line}: table "${raw.name}" must give every field an id, or none.`
			);
		}
		order.sort((a, b) => Number(a.raw.attrs.get('id')) - Number(b.raw.attrs.get('id')));
	}
	let next = 0;
	for (const { f, raw: rf } of order) {
		const hasUnion =
			f.type.kind === 'union' || (f.type.kind === 'vector' && f.type.elem.kind === 'union');
		if (withIds) {
			f.slot = Number(rf.attrs.get('id'));
			f.typeSlot = hasUnion ? f.slot - 1 : -1;
		} else if (hasUnion) {
			f.typeSlot = next++;
			f.slot = next++;
		} else {
			f.slot = next++;
		}
	}
}
