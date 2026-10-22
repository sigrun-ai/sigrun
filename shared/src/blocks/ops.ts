/**
 * `applyOps` and `resolvePointer` (UI-blocks spec §4.2/§4.3): the single
 * applier every surface's data updates go through, and the pointer
 * reader bindings resolve with.
 *
 * Purity contract:
 *
 * - `applyOps` NEVER mutates its input — it clones along the touched
 *   path only (copy-on-write), so a batch of ops over a large document
 *   shares every untouched branch by reference with the input. The
 *   property suite pins this (frozen inputs, snapshot equality).
 * - Pointers are RFC 6901 with `~0` (`~`) and `~1` (`/`) escaping, plus
 *   the one extension (spec §4.2): a pointer starting `./` resolves
 *   against the passed `item` (a collection's item template), which
 *   only `resolvePointer` takes — the DATA side never sees `./`.
 * - A failing op throws `DataOpError` carrying the op's INDEX, so the
 *   caller (U3/U5) can treat it as the full-refetch signal (spec §16).
 */

import type { JsonObject, JsonValue } from "../json.js";
import type { DataOp } from "./types.js";

/** An op that could not be applied; `opIndex` names which one failed. */
export class DataOpError extends Error {
	readonly opIndex: number;

	constructor(opIndex: number, message: string) {
		super(message);
		this.name = "DataOpError";
		this.opIndex = opIndex;
	}
}

/** A container on the op path: a JSON object or an array. */
type Container = JsonObject | JsonValue[];

function isContainer(value: JsonValue): value is Container {
	return Array.isArray(value) || typeof value === "object";
}

/** Split an RFC 6901 pointer into unescaped reference tokens. */
function pointerTokens(pointer: string): string[] {
	if (pointer === "") return [];
	if (!pointer.startsWith("/")) {
		throw new Error(`invalid pointer: ${pointer}`);
	}
	return pointer
		.slice(1)
		.split("/")
		.map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** Read `token` from a container; `undefined` when absent. */
function readToken(container: Container, token: string): JsonValue | undefined {
	if (Array.isArray(container)) {
		if (!/^\d+$/.test(token)) return undefined;
		const index = Number(token);
		return index < container.length ? container[index] : undefined;
	}
	return Object.prototype.hasOwnProperty.call(container, token)
		? container[token]
		: undefined;
}

/** Parse `key` as an array index valid INSIDE `array` (not for append). */
function arrayIndex(array: JsonValue[], key: string, pointer: string): number {
	if (!/^\d+$/.test(key)) {
		throw new Error(`not an array index: ${pointer}`);
	}
	const index = Number(key);
	if (index >= array.length) {
		throw new Error(`index out of bounds: ${pointer}`);
	}
	return index;
}

/** Parse `key` as an array index valid for INSERTION (== length allowed). */
function insertIndex(array: JsonValue[], key: string, pointer: string): number {
	if (key === "-") return array.length;
	if (!/^\d+$/.test(key)) {
		throw new Error(`not an array index: ${pointer}`);
	}
	const index = Number(key);
	if (index > array.length) {
		throw new Error(`index out of bounds: ${pointer}`);
	}
	return index;
}

/**
 * READ-ONLY walk: resolve the tokens before the last and return the
 * parent container plus the final token. Throws when any step is
 * missing or not a container.
 */
function resolveParent(
	root: JsonObject,
	tokens: string[],
	opIndex: number,
	pointer: string,
): { parent: Container; key: string } {
	let node: JsonValue = root;
	for (let i = 0; i < tokens.length - 1; i++) {
		if (!isContainer(node)) {
			throw new DataOpError(opIndex, `path not found: ${pointer}`);
		}
		const next = readToken(node, tokens[i]);
		if (next === undefined) {
			throw new DataOpError(opIndex, `path not found: ${pointer}`);
		}
		node = next;
	}
	if (!isContainer(node)) {
		throw new DataOpError(opIndex, `path not found: ${pointer}`);
	}
	return { parent: node, key: tokens[tokens.length - 1] };
}

/**
 * Clone-on-write rewrite: copies every container along `tokens` from
 * `data` down, hands the (fresh, cloned) final container to `mutate`,
 * and returns the new root. The input is never touched; branches off
 * the path are shared by reference with it.
 */
function withWrite(
	data: JsonObject,
	tokens: string[],
	mutate: (parent: Container, key: string) => void,
): JsonObject {
	const rootClone: JsonObject = { ...data };
	let node: Container = rootClone;
	for (let i = 0; i < tokens.length - 1; i++) {
		const child = readToken(node, tokens[i]);
		if (child === undefined || !isContainer(child)) {
			throw new Error(`path not found: /${tokens.join("/")}`);
		}
		const childClone: Container = Array.isArray(child)
			? ([...child] as JsonValue[])
			: ({ ...child } as JsonObject);
		if (Array.isArray(node)) {
			node[Number(tokens[i])] = childClone;
		} else {
			node[tokens[i]] = childClone;
		}
		node = childClone;
	}
	mutate(node, tokens[tokens.length - 1]);
	return rootClone;
}

/**
 * Apply a batch of `DataOp`s (spec §4.3) to `data`, returning a NEW
 * object. Pure: untouched branches are shared by reference with the
 * input; the input is never mutated. Ops apply sequentially — an
 * earlier op's write is visible to the next.
 *
 * Throws `DataOpError` (naming the op's index) on any op whose path
 * does not exist, or whose target is not an array where one is required.
 */
export function applyOps(data: JsonObject, ops: readonly DataOp[]): JsonObject {
	let current: JsonObject = data;
	for (let opIndex = 0; opIndex < ops.length; opIndex++) {
		const op = ops[opIndex];
		try {
			current = applyOne(current, op, opIndex);
		} catch (error) {
			if (error instanceof DataOpError) throw error;
			throw new DataOpError(
				opIndex,
				`${op.op} ${"path" in op ? op.path : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	return current;
}

function applyOne(data: JsonObject, op: DataOp, opIndex: number): JsonObject {
	switch (op.op) {
		case "set":
			return opSet(data, op.path, op.value, opIndex);
		case "remove":
			return opRemove(data, op.path, opIndex);
		case "insert":
			return opInsert(data, op.path, op.value, opIndex);
		case "move":
			return opMove(data, op.from, op.path, opIndex);
	}
}

/** `set`: assign at `path` (an existing array slot, or a created object member). */
function opSet(
	data: JsonObject,
	path: string,
	value: JsonValue,
	opIndex: number,
): JsonObject {
	const tokens = pointerTokens(path);
	if (tokens.length === 0) {
		throw new DataOpError(opIndex, "set at the root is not allowed");
	}
	const { parent, key } = resolveParent(data, tokens, opIndex, path);
	if (Array.isArray(parent)) {
		arrayIndex(parent, key, path); // validate before cloning
	}
	return withWrite(data, tokens, (container, finalKey) => {
		if (Array.isArray(container)) {
			container[arrayIndex(container, finalKey, path)] = value;
		} else {
			container[finalKey] = value;
		}
	});
}

/** `remove`: delete the member at `path` (shifting array elements). */
function opRemove(data: JsonObject, path: string, opIndex: number): JsonObject {
	const tokens = pointerTokens(path);
	if (tokens.length === 0) {
		throw new DataOpError(opIndex, "remove at the root is not allowed");
	}
	const { parent, key } = resolveParent(data, tokens, opIndex, path);
	if (Array.isArray(parent)) {
		arrayIndex(parent, key, path); // throws (→ opIndex) when out of bounds
	} else if (!Object.prototype.hasOwnProperty.call(parent, key)) {
		throw new DataOpError(opIndex, `path not found: ${path}`);
	}
	return withWrite(data, tokens, (container, finalKey) => {
		if (Array.isArray(container)) {
			container.splice(arrayIndex(container, finalKey, path), 1);
		} else {
			delete container[finalKey];
		}
	});
}

/** `insert`: insert `value` into the array at `path` (`-` appends). */
function opInsert(
	data: JsonObject,
	path: string,
	value: JsonValue,
	opIndex: number,
): JsonObject {
	const tokens = pointerTokens(path);
	if (tokens.length === 0) {
		throw new DataOpError(opIndex, `not an array: ${path}`);
	}
	const { parent } = resolveParent(data, tokens, opIndex, path);
	if (!Array.isArray(parent)) {
		throw new DataOpError(opIndex, `not an array: ${path}`);
	}
	return withWrite(data, tokens, (container, finalKey) => {
		if (Array.isArray(container)) {
			container.splice(insertIndex(container, finalKey, path), 0, value);
		}
	});
}

/**
 * `move`: remove the item at `from`, then insert it at `path` — a
 * reorder within one array or a move across arrays (spec §4.3: it
 * exists so reorders don't re-send the moved item). Both ends must be
 * array slots; the destination index is resolved against the
 * post-removal array.
 */
function opMove(
	data: JsonObject,
	from: string,
	path: string,
	opIndex: number,
): JsonObject {
	const fromTokens = pointerTokens(from);
	const toTokens = pointerTokens(path);
	if (fromTokens.length === 0 || toTokens.length === 0) {
		throw new DataOpError(opIndex, "move at the root is not allowed");
	}
	const source = resolveParent(data, fromTokens, opIndex, from);
	if (!Array.isArray(source.parent)) {
		throw new DataOpError(opIndex, `not an array: ${from}`);
	}
	const value = readToken(source.parent, source.key);
	if (value === undefined) {
		throw new DataOpError(opIndex, `path not found: ${from}`);
	}

	// Remove first: a move into the same array sees post-removal indices.
	const removed = withWrite(data, fromTokens, (container, finalKey) => {
		if (Array.isArray(container)) {
			container.splice(arrayIndex(container, finalKey, from), 1);
		}
	});

	const to = resolveParent(removed, toTokens, opIndex, path);
	if (!Array.isArray(to.parent)) {
		throw new DataOpError(opIndex, `not an array: ${path}`);
	}
	return withWrite(removed, toTokens, (container, finalKey) => {
		if (Array.isArray(container)) {
			container.splice(insertIndex(container, finalKey, path), 0, value);
		}
	});
}

/**
 * Resolve an RFC 6901 `pointer` against `data`; a pointer starting
 * `./` resolves against `item` instead (spec §4.2's one extension,
 * used inside collection item templates). A missing path is
 * `undefined`, never an error — "a binding to a missing path renders
 * as empty, never as an error".
 */
export function resolvePointer(
	data: JsonValue,
	pointer: string,
	item?: JsonValue,
): JsonValue | undefined {
	const base = pointer.startsWith("./") ? item : data;
	if (base === undefined) return undefined;
	const rest = pointer.startsWith("./") ? pointer.slice(1) : pointer;
	let node: JsonValue = base;
	for (const token of pointerTokens(rest)) {
		if (!isContainer(node)) return undefined;
		const next = readToken(node, token);
		if (next === undefined) return undefined;
		node = next;
	}
	return node;
}
