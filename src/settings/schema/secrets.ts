/**
 * The pure secret plumbing behind schema-backed settings (spec §4): the
 * generator names every `writeOnly` slot as a {@link SecretPath} pattern,
 * and these four functions turn those patterns into concrete store keys
 * and values — split a submission's secret values out of the settings
 * object, work out which store keys a save must move or delete, fill the
 * values back in for the checked read, and compute the statuses the
 * channels render. Nothing here does I/O: the store is the caller's,
 * reached through the `read`/`status` callbacks.
 *
 * **Store key encoding.** The property path joined with `/`, one segment
 * per pattern segment (`servers/mcp-gateway/headers/Authorization`). A
 * TOP-LEVEL secret keeps its bare name, so the existing
 * `SIGRUN_EXT_<SLUG>_<KEY>` env fallback still resolves for it. A
 * table's `*` is the entry key the stored data carries; an array's `*`
 * is the entry's identity VALUE — the `x-sigrun-key` property named by
 * {@link SecretPath.key}, or the `$from` marker a channel submits for an
 * entry it loaded. An entry with neither has no stable identity: its
 * secret values are still stripped from the plain object (they must
 * never reach the file) but nothing is stored for them, which is why
 * `checkSchema` requires `x-sigrun-key` on an array item that holds
 * secrets.
 *
 * **A submission keys on the identity it was LOADED under** (`$from`,
 * else the identity property), because that is where its secrets sit in
 * the store; {@link secretMoves} then carries an entry's secrets to the
 * key the file now names. Applying one save is therefore a sequence, and
 * the sequence is the contract (`settings-surfaces.ts`, Task 7):
 *
 * 1. `splitSecrets().writes` — set each key;
 * 2. `splitSecrets().deletes` — delete each explicitly cleared key;
 * 3. `secretMoves().moves` — copy the source key's value to its target,
 *    then delete the source;
 * 4. `secretMoves().deletes` — delete the keys of dropped entries.
 *
 * The order matters: a rotated value is written at the loaded key before
 * its entry's move carries it, and a cleared value is gone before the
 * move looks for it (so clearing and renaming never resurrects it).
 *
 * **These functions take the FILE shape, not the channel's wire shape.**
 * A table of `writeOnly` strings is a flat string map on disk
 * (`{headers: {Authorization: "Bearer x"}}`, the schema's
 * `additionalProperties: {type: "string"}`), while both channels pack a
 * row as an entry object (`{Authorization: {value: "Bearer x"}}`).
 * Unpacking the channel's entries is the save path's step, run alongside
 * the `$from` strip before validation (Task 7); this module never sees a
 * channel shape and must not learn one.
 *
 * **Secret names inside a table of secret values stay in the file.** A
 * `headers` map of `writeOnly` strings keys its secrets by the header
 * name, which exists only in the data — so {@link splitSecrets} leaves
 * an empty-string placeholder (`{"Authorization": ""}`) where it takes
 * the value out, exactly the "no value here" an untouched field
 * submits. Without it the next render could not name the header at all.
 * A slot the pattern names outright is removed instead.
 */

import type { SecretPath } from "./generate.js";

/** One concrete secret slot found while walking a settings object. */
interface SecretSlot {
	/** The store key, or undefined when the entry has no stable identity. */
	readonly key: string | undefined;
	/** The container holding the value (a table entry object or an array). */
	readonly parent: Record<string, unknown> | unknown[];
	/** The property name or array index of the value in `parent`. */
	readonly leaf: string | number;
	/** The value at the slot; undefined when the slot is absent. */
	readonly value: unknown;
	/** Whether the leaf's name is a table entry key (a `*` over an object). */
	readonly keepName: boolean;
}

/** The split product: the settings without secret values, and what to store. */
export interface SecretSplit {
	/** `values` minus every secret value (a table of secret values keeps its names). */
	readonly plain: Record<string, unknown>;
	/** Store key → value, for every non-empty secret submission. */
	readonly writes: ReadonlyMap<string, string>;
	/** Store keys an explicit clear (`null`) deletes. */
	readonly deletes: readonly string[];
}

/** The move product of one save, read off the submitted entries' `$from`. */
export interface SecretMove {
	/** Old store key → new store key, for every renamed entry. */
	readonly moves: ReadonlyMap<string, string>;
	/** Store keys whose entry the submission no longer has. */
	readonly deletes: readonly string[];
}

/** How an entry's identity segment resolves. */
type Identity = (entry: Record<string, unknown>) => string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON-pointer segment back to its data spelling (`~1` → `/`). */
function unescapeSegment(segment: string): string {
	return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** The pattern's segments, unescaped and without the leading empty one. */
function segmentsOf(pattern: string): readonly string[] {
	const raw = pattern.startsWith("/") ? pattern.slice(1) : pattern;
	return raw === "" ? [] : raw.split("/").map(unescapeSegment);
}

/** A deep copy of one settings object (settings values are JSON). */
function cloneObject(value: Record<string, unknown>): Record<string, unknown> {
	return structuredClone(value);
}

/** The non-empty string at `name`, or undefined. */
function stringAt(entry: Record<string, unknown>, name: string | undefined): string | undefined {
	if (name === undefined) return undefined;
	const value = entry[name];
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** The identity an entry was LOADED under: its `$from` marker, else its own identity value. */
function loadedIdentity(key: string | undefined): Identity {
	return (entry) => stringAt(entry, "$from") ?? stringAt(entry, key);
}

/** The identity an entry RENDERS under: its own identity value. */
function renderedIdentity(key: string | undefined): Identity {
	return (entry) => stringAt(entry, key);
}

/** Join a resolved prefix into a store key; an unresolved prefix stays undefined. */
function joinKey(prefix: readonly string[] | undefined): string | undefined {
	return prefix === undefined ? undefined : prefix.join("/");
}

/** The indexes of a pattern's identity segments (`*`). */
function identityLevels(segments: readonly string[]): number[] {
	return segments.flatMap((segment, at) => (segment === "*" ? [at] : []));
}

/**
 * Walk one pattern over `container`, handing every secret slot to
 * `visit`. An absent leaf is still a slot (the fill and status walks
 * must name a secret the file never carries); an absent intermediate
 * ends the branch. A slot below an entry with no identity is visited
 * with `key` undefined, so its value is still stripped from the plain
 * object.
 */
function walk(
	container: unknown,
	segments: readonly string[],
	at: number,
	prefix: readonly string[] | undefined,
	identity: Identity,
	visit: (slot: SecretSlot) => void,
): void {
	const segment = segments[at];
	if (segment === undefined) return;
	const last = at === segments.length - 1;
	if (Array.isArray(container)) {
		// An array segment is always its identity segment (`*`).
		if (segment !== "*") return;
		for (const [index, entry] of container.entries()) {
			const id = isRecord(entry) ? identity(entry) : undefined;
			const next = prefix === undefined || id === undefined ? undefined : [...prefix, id];
			if (last) {
				visit({ key: joinKey(next), parent: container, leaf: index, value: entry, keepName: false });
			} else {
				walk(entry, segments, at + 1, next, identity, visit);
			}
		}
		return;
	}
	if (!isRecord(container)) return;
	if (segment !== "*") {
		const next = prefix === undefined ? undefined : [...prefix, segment];
		if (last) {
			visit({
				key: joinKey(next),
				parent: container,
				leaf: segment,
				value: container[segment],
				keepName: false,
			});
			return;
		}
		if (!Object.hasOwn(container, segment)) return;
		walk(container[segment], segments, at + 1, next, identity, visit);
		return;
	}
	for (const [name, child] of Object.entries(container)) {
		const next = prefix === undefined ? undefined : [...prefix, name];
		if (last) {
			visit({ key: joinKey(next), parent: container, leaf: name, value: child, keepName: true });
		} else {
			walk(child, segments, at + 1, next, identity, visit);
		}
	}
}

/** Every secret slot of `settings`, in pattern order. */
function slotsOf(
	settings: Record<string, unknown>,
	secrets: readonly SecretPath[],
	identityFor: (secret: SecretPath) => Identity,
): SecretSlot[] {
	const slots: SecretSlot[] = [];
	for (const secret of secrets) {
		const segments = segmentsOf(secret.pattern);
		walk(settings, segments, 0, [], identityFor(secret), (slot) => slots.push(slot));
	}
	return slots;
}

/** The distinct store keys a slot list resolves. */
function keysOf(slots: readonly SecretSlot[]): string[] {
	return [...new Set(slots.flatMap((slot) => (slot.key === undefined ? [] : [slot.key])))];
}

/**
 * Take one secret value out of the plain object (see the module doc): an
 * empty placeholder where the slot's NAME lives only in the data, and
 * plain removal where the pattern spells the name.
 */
function removeSlot(slot: SecretSlot): void {
	if (Array.isArray(slot.parent)) slot.parent[slot.leaf as number] = "";
	else if (slot.keepName) slot.parent[slot.leaf as string] = "";
	else delete slot.parent[slot.leaf as string];
}

/**
 * Remove every secret value from `values`; return them keyed by concrete
 * store key. "" and absent both mean unchanged — never a delete.
 */
export function splitSecrets(
	values: Record<string, unknown>,
	secrets: readonly SecretPath[],
): SecretSplit {
	const plain = cloneObject(values);
	const writes = new Map<string, string>();
	const deletes: string[] = [];
	for (const slot of slotsOf(plain, secrets, (secret) => loadedIdentity(secret.key))) {
		if (slot.key !== undefined) {
			// "" is an untouched write-only field; null is the clear action.
			if (typeof slot.value === "string" && slot.value !== "") {
				writes.set(slot.key, slot.value);
			} else if (slot.value === null) {
				deletes.push(slot.key);
			}
		}
		removeSlot(slot);
	}
	return { plain, writes, deletes };
}

/**
 * The entries at one identity level of a pattern, as
 * loaded-key → rendered-key prefix pairs. A table entry renders under
 * its own name; an array entry under its identity property's value.
 */
function entryPrefixes(
	object: Record<string, unknown>,
	segments: readonly string[],
	level: number,
	identityFor: Identity,
): Map<string, string> {
	const pairs = new Map<string, string>();
	const descend = (
		container: unknown,
		at: number,
		loaded: readonly string[],
		rendered: readonly string[],
	): void => {
		if (at === level) {
			if (Array.isArray(container)) {
				for (const entry of container) {
					if (!isRecord(entry)) continue;
					const renderedId = identityFor(entry);
					if (renderedId === undefined) continue;
					const loadedId = stringAt(entry, "$from") ?? renderedId;
					pairs.set([...loaded, loadedId].join("/"), [...rendered, renderedId].join("/"));
				}
				return;
			}
			if (!isRecord(container)) return;
			for (const [name, entry] of Object.entries(container)) {
				const loadedId = (isRecord(entry) ? stringAt(entry, "$from") : undefined) ?? name;
				pairs.set([...loaded, loadedId].join("/"), [...rendered, name].join("/"));
			}
			return;
		}
		const segment = segments[at];
		if (segment === undefined) return;
		if (Array.isArray(container)) {
			if (segment !== "*") return;
			for (const entry of container) {
				if (!isRecord(entry)) continue;
				const id = identityFor(entry);
				if (id === undefined) continue;
				descend(entry, at + 1, [...loaded, id], [...rendered, id]);
			}
			return;
		}
		if (!isRecord(container)) return;
		if (segment === "*") {
			for (const [name, child] of Object.entries(container)) {
				descend(child, at + 1, [...loaded, name], [...rendered, name]);
			}
			return;
		}
		descend(container[segment], at + 1, [...loaded, segment], [...rendered, segment]);
	};
	descend(object, 0, [], []);
	return pairs;
}

/**
 * Store keys to move or delete, from the submitted entries' `$from`
 * markers vs the stored object: an entry renamed under a new key moves
 * its secrets, an entry the submission dropped loses them.
 *
 * Every identity level is part of a store key, so an entry missing at
 * ANY level means the key is dead and is deleted — a removed server, and
 * equally a removed row inside it. A level whose entry is still there
 * under a different name contributes a move, which is how a rename
 * carries its secrets along.
 */
export function secretMoves(
	stored: Record<string, unknown>,
	submitted: Record<string, unknown>,
	secrets: readonly SecretPath[],
): SecretMove {
	const moves = new Map<string, string>();
	const deletes = new Set<string>();
	for (const secret of secrets) {
		const segments = segmentsOf(secret.pattern);
		const levels = identityLevels(segments);
		// A named slot has no entry identity, so nothing can move or drop.
		if (levels.length === 0) continue;
		const render = renderedIdentity(secret.key);
		const storedKeys = keysOf(slotsOf(stored, [secret], () => render));
		if (storedKeys.length === 0) continue;
		// One loaded→rendered map per identity level, so a key can be
		// followed through nested renames.
		const submittedAt = levels.map((level) => entryPrefixes(submitted, segments, level, render));
		for (const key of storedKeys) {
			// `parts` starts as the stored key and is rewritten one identity
			// level at a time into the key the submission now names.
			let parts = key.split("/");
			let alive = true;
			for (const [index, level] of levels.entries()) {
				const prefix = parts.slice(0, level + 1).join("/");
				const rendered = submittedAt[index]?.get(prefix);
				if (rendered === undefined) {
					alive = false;
					break;
				}
				parts = [...rendered.split("/"), ...parts.slice(level + 1)];
			}
			if (!alive) {
				deletes.add(key);
				continue;
			}
			const next = parts.join("/");
			if (next !== key) moves.set(key, next);
		}
	}
	return { moves, deletes: [...deletes] };
}

/** Fill secret values into a settings object (the checked read). Missing secrets stay absent. */
export async function fillSecrets(
	settings: Record<string, unknown>,
	secrets: readonly SecretPath[],
	read: (key: string) => Promise<string | undefined>,
): Promise<Record<string, unknown>> {
	const filled = cloneObject(settings);
	// Each entry resolves to the key it was LOADED under: for the stored file
	// (no `$from`) that is its own identity, and for a submission it is the
	// `$from` marker — in both cases the key the value is stored under.
	const slots = slotsOf(filled, secrets, (secret) => loadedIdentity(secret.key));
	const values = new Map<string, string>();
	const resolved = await Promise.all(
		keysOf(slots).map(async (key) => [key, await read(key)] as const),
	);
	for (const [key, value] of resolved) {
		if (value !== undefined) values.set(key, value);
	}
	for (const slot of slots) {
		if (slot.key === undefined) continue;
		const value = values.get(slot.key);
		if (value === undefined) continue;
		if (Array.isArray(slot.parent)) slot.parent[slot.leaf as number] = value;
		else slot.parent[slot.leaf as string] = value;
	}
	return filled;
}

/**
 * Per-secret status for render data (`data.secrets`): `stored` or `env`,
 * keyed by concrete store key — the key the value is STORED under, which
 * is the key the entries renderers look up (they compose it from the
 * identity the row was saved as, `$from` or the identity it renders
 * with). A new unsaved entry has neither, so it contributes no key and
 * its secret renders as "not set"; a key with no status is absent from
 * the result, and a value is never part of it.
 */
export async function secretStatuses(
	settings: Record<string, unknown>,
	secrets: readonly SecretPath[],
	status: (key: string) => Promise<"stored" | "env" | undefined>,
): Promise<Record<string, "stored" | "env">> {
	const keys = keysOf(slotsOf(settings, secrets, (secret) => loadedIdentity(secret.key)));
	const resolved = await Promise.all(keys.map(async (key) => [key, await status(key)] as const));
	const statuses: Record<string, "stored" | "env"> = {};
	for (const [key, source] of resolved) {
		if (source !== undefined) statuses[key] = source;
	}
	return statuses;
}
