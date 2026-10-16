import protobuf from 'protobufjs';
import { int64FromParts, type DType, type Node } from '../model';

/**
 * Generic protobufjs message -> Node conversion, driven by reflection.
 * Format-specific tweaks plug in through `hooks`, keyed by message full name.
 */

/** Return a replacement {name, node} for a field, null to drop it, or undefined for default handling. */
export type FieldHook = (
	msg: Record<string, unknown>,
	field: protobuf.Field
) => { name: string; node: Node } | null | undefined;

export type Hooks = Record<string, FieldHook>;

const SCALAR_DTYPES: Record<string, DType> = {
	double: 'float64',
	float: 'float32',
	int32: 'int32',
	sint32: 'int32',
	sfixed32: 'int32',
	uint32: 'uint32',
	fixed32: 'uint32',
	int64: 'int64',
	sint64: 'int64',
	sfixed64: 'int64',
	uint64: 'uint64',
	fixed64: 'uint64',
	bool: 'bool'
};

interface LongLike {
	low: number;
	high: number;
	unsigned: boolean;
}

function wideToValue(v: unknown, unsigned: boolean): number | bigint {
	if (typeof v === 'number') return v;
	const l = v as LongLike;
	return int64FromParts(l.low >>> 0, unsigned ? l.high >>> 0 : l.high, unsigned);
}

function scalarOf(dtype: DType, v: unknown): number | bigint | boolean {
	if (dtype === 'int64') return wideToValue(v, false);
	if (dtype === 'uint64') return wideToValue(v, true);
	return v as number | boolean;
}

export function messageToNode(
	type: protobuf.Type,
	msg: Record<string, unknown>,
	hooks: Hooks
): Node {
	const hook = hooks[type.fullName];
	const entries: [string, Node][] = [];
	for (const field of type.fieldsArray) {
		// Unset optional fields only exist on the prototype (proto2 defaults).
		if (!Object.prototype.hasOwnProperty.call(msg, field.name)) continue;
		const value = msg[field.name];
		if (value == null) continue;
		if (field.repeated && (value as unknown[]).length === 0) continue;
		const override = hook?.(msg, field);
		if (override === null) continue;
		if (override) {
			entries.push([override.name, override.node]);
			continue;
		}
		entries.push([field.name, fieldToNode(field, value, hooks)]);
	}
	return { k: 'obj', entries };
}

function fieldToNode(field: protobuf.Field, value: unknown, hooks: Hooks): Node {
	if (field.map) {
		const m = value as Record<string, unknown>;
		return {
			k: 'obj',
			entries: Object.keys(m).map((key) => [key, singleToNode(field, m[key], hooks)])
		};
	}
	if (!field.repeated) return singleToNode(field, value, hooks);

	const list = value as unknown[];
	const dtype = SCALAR_DTYPES[field.type];
	if (dtype) {
		return { k: 'array', dtype, length: list.length, get: (i) => scalarOf(dtype, list[i]) };
	}
	return { k: 'list', items: list.map((v) => singleToNode(field, v, hooks)) };
}

function singleToNode(field: protobuf.Field, v: unknown, hooks: Hooks): Node {
	const resolved = field.resolvedType;
	if (resolved instanceof protobuf.Type) {
		return messageToNode(resolved, v as Record<string, unknown>, hooks);
	}
	if (resolved instanceof protobuf.Enum) {
		const num = v as number;
		return { k: 'enum', name: resolved.valuesById[num] ?? String(num), num };
	}
	if (field.type === 'string') return { k: 'str', v: v as string };
	if (field.type === 'bytes') return { k: 'bytes', v: v as Uint8Array };
	const dtype = SCALAR_DTYPES[field.type];
	if (!dtype) throw new Error(`Unsupported protobuf field type: ${field.type}`);
	return { k: 'scalar', dtype, v: scalarOf(dtype, v) };
}
