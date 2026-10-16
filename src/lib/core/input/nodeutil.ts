import type { Node } from '../model';

/** Small helpers for post-processing decoded Node trees. */

export type Obj = Extract<Node, { k: 'obj' }>;

export function get(obj: Obj | undefined, key: string): Node | undefined {
	return obj?.entries.find(([k]) => k === key)?.[1];
}

export function asObj(n: Node | undefined): Obj | undefined {
	return n?.k === 'obj' ? n : undefined;
}

export function asList(n: Node | undefined): Node[] {
	return n?.k === 'list' ? n.items : [];
}

/** A scalar node's value as a number (undefined if not a scalar). */
export function asNumber(n: Node | undefined): number | undefined {
	return n?.k === 'scalar' && typeof n.v !== 'boolean' ? Number(n.v) : undefined;
}

/** An enum node's name. */
export function enumName(n: Node | undefined): string | undefined {
	return n?.k === 'enum' ? n.name : undefined;
}
