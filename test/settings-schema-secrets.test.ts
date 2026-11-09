/**
 * Settings rework Task 5: the pure secret plumbing — splitting secret
 * values out of a submitted settings object, computing the store-key
 * moves and deletes a save implies, filling values back in for the
 * checked read, and computing the per-secret statuses the channels
 * render.
 *
 * Every store key here is the property path joined with `/`: a table
 * entry contributes its key, an array entry the value of the item's
 * `x-sigrun-key` property, and a top-level secret keeps its bare name.
 */

import { describe, expect, it } from "vitest";
import type { SecretPath } from "../src/settings/schema/index.js";
import {
	fillSecrets,
	secretMoves,
	secretStatuses,
	splitSecrets,
} from "../src/settings/schema/secrets.js";

/** A top-level credential, a table of header secrets, an array of providers. */
const SECRETS: readonly SecretPath[] = [
	{ pattern: "/token" },
	{ pattern: "/servers/*/headers/*" },
	{ pattern: "/providers/*/clientSecret", key: "id" },
];

describe("splitSecrets", () => {
	it("split removes nested header values and keys them by path", () => {
		const values = {
			token: "acme-top-level",
			accept: "application/json",
			servers: {
				"mcp-gateway": {
					url: "https://gw.example.invalid",
					headers: { Authorization: "Bearer acme-header" },
				},
			},
		};
		const { plain, writes, deletes } = splitSecrets(values, SECRETS);
		expect([...writes]).toEqual([
			["token", "acme-top-level"],
			["servers/mcp-gateway/headers/Authorization", "Bearer acme-header"],
		]);
		expect(deletes).toEqual([]);
		// Every secret value is gone; a table of secret values keeps its
		// NAMES (they exist only in the data, and the next render needs them),
		// while a slot the pattern names outright is removed.
		expect(plain).toEqual({
			accept: "application/json",
			servers: {
				"mcp-gateway": { url: "https://gw.example.invalid", headers: { Authorization: "" } },
			},
		});
		// The submitted object is never mutated.
		expect(values.token).toBe("acme-top-level");
		expect(values.servers["mcp-gateway"].headers).toEqual({
			Authorization: "Bearer acme-header",
		});

		// These functions take the FILE shape. A channel's entry object
		// (`{value: "..."}`) is unpacked by the save path before it gets here,
		// so it is not a secret value and never becomes a write.
		const wire = splitSecrets(
			{ servers: { acme: { headers: { Authorization: { value: "Bearer acme" } } } } },
			SECRETS,
		);
		expect(wire.writes.size).toBe(0);
	});

	it("a renamed table entry writes its secret to the loaded key", () => {
		// Rename acme → acme-2 AND rotate the header in one save. Under the
		// documented order (writes, then moves) a write addressed to the NEW
		// name would be overwritten by the move copying the OLD stored value
		// on top of it, so the write must address the key the entry was
		// LOADED under.
		const { writes, plain } = splitSecrets(
			{
				servers: {
					"acme-2": { $from: "acme", headers: { Authorization: "rotated" } },
				},
			},
			SECRETS,
		);
		expect([...writes]).toEqual([["servers/acme/headers/Authorization", "rotated"]]);

		// A new entry (no `$from`) keys on its rendered name.
		const fresh = splitSecrets(
			{ servers: { fresh: { headers: { Authorization: "new" } } } },
			SECRETS,
		);
		expect([...fresh.writes]).toEqual([["servers/fresh/headers/Authorization", "new"]]);

		// The plain object still carries the row under its SUBMITTED name, with
		// its `$from` intact (stripping it is the save path's step): the rename
		// is the file's business, not the secret walk's.
		expect(plain).toEqual({
			servers: { "acme-2": { $from: "acme", headers: { Authorization: "" } } },
		});
	});

	it("empty secret submission is unchanged, not a delete", () => {		// An untouched write-only field submits "" — that is "unchanged".
		const emptied = splitSecrets(
			{ token: "", servers: { acme: { headers: { Authorization: "" } } } },
			SECRETS,
		);
		expect(emptied.writes.size).toBe(0);
		expect(emptied.deletes).toEqual([]);
		expect(emptied.plain).toEqual({
			servers: { acme: { headers: { Authorization: "" } } },
		});

		// An absent slot is unchanged too, and never deletes.
		const absent = splitSecrets({}, SECRETS);
		expect(absent.writes.size).toBe(0);
		expect(absent.deletes).toEqual([]);
		expect(absent.plain).toEqual({});

		// An explicit clear (the channels' clear action submits null) is a
		// delete, never a write of the empty string.
		const cleared = splitSecrets(
			{ token: null, servers: { acme: { headers: { Authorization: null } } } },
			SECRETS,
		);
		expect(cleared.writes.size).toBe(0);
		expect(cleared.deletes).toEqual([
			"token",
			"servers/acme/headers/Authorization",
		]);
		expect(cleared.plain).toEqual({
			servers: { acme: { headers: { Authorization: "" } } },
		});
	});
});

describe("secretMoves", () => {
	it("table rename yields a move", () => {
		const stored = {
			servers: {
				acme: {
					url: "https://acme.example.invalid",
					headers: { Authorization: "Bearer acme" },
				},
			},
		};
		// A channel submits the entry under its new key, carrying the key it
		// was loaded under in `$from`.
		const submitted = {
			servers: {
				"acme-renamed": {
					$from: "acme",
					url: "https://acme.example.invalid",
					// A channel renders the stored file, so the header name comes
					// back with the empty placeholder splitSecrets left there.
					headers: { Authorization: "" },
				},
			},
		};
		const { moves, deletes } = secretMoves(stored, submitted, SECRETS);
		expect([...moves]).toEqual([
			[
				"servers/acme/headers/Authorization",
				"servers/acme-renamed/headers/Authorization",
			],
		]);
		expect(deletes).toEqual([]);

		// A rename at an INNER level moves too: both entries are objects, so
		// both carry their loaded identity.
		const nested = [{ pattern: "/servers/*/backends/*/token" }];
		const innerStored = {
			servers: { acme: { backends: { east: { token: "east-token" } } } },
		};
		const innerSubmitted = {
			servers: {
				acme: { backends: { "east-1": { $from: "east", token: "" } } },
			},
		};
		expect([...secretMoves(innerStored, innerSubmitted, nested).moves]).toEqual([
			["servers/acme/backends/east/token", "servers/acme/backends/east-1/token"],
		]);
		// Both levels renamed at once: the key is followed through both.
		const bothLevels = {
			servers: { acme: { backends: { "east-1": { $from: "east", token: "" } } } },
		};
		expect([
			...secretMoves(
				innerStored,
				{ servers: { "acme-2": { $from: "acme", ...bothLevels.servers.acme } } },
				nested,
			).moves,
		]).toEqual([["servers/acme/backends/east/token", "servers/acme-2/backends/east-1/token"]]);
	});

	it("an identity containing a slash is not split into extra levels", () => {
		// Store keys are joined with "/", so a table key or array identity may
		// itself contain one. Reconstructing an entry's identity prefix by
		// splitting the joined key would invent a level and miss the entry —
		// a spurious delete, and silent loss of the secret.
		const stored = { servers: { "acme/mcp": { headers: { Authorization: "Bearer x" } } } };
		const unchanged = secretMoves(
			stored,
			{ servers: { "acme/mcp": { $from: "acme/mcp", headers: { Authorization: "" } } } },
			SECRETS,
		);
		expect([...unchanged.moves]).toEqual([]);
		expect(unchanged.deletes).toEqual([]);

		// A rename still moves (never deletes) that entry's secret.
		const renamed = secretMoves(
			stored,
			{ servers: { "acme-mcp": { $from: "acme/mcp", headers: { Authorization: "" } } } },
			SECRETS,
		);
		expect([...renamed.moves]).toEqual([
			["servers/acme/mcp/headers/Authorization", "servers/acme-mcp/headers/Authorization"],
		]);
		expect(renamed.deletes).toEqual([]);

		// An array identity containing a slash behaves the same way.
		const arraySecrets = [{ pattern: "/providers/*/clientSecret", key: "id" }];
		const arrayStored = { providers: [{ id: "acme/mcp", clientSecret: "" }] };
		expect([
			...secretMoves(
				arrayStored,
				{ providers: [{ id: "acme-mcp", $from: "acme/mcp", clientSecret: "" }] },
				arraySecrets,
			).moves,
		]).toEqual([["providers/acme/mcp/clientSecret", "providers/acme-mcp/clientSecret"]]);
	});

	it("removed table entry yields deletes for its secrets", () => {
		const stored = {
			servers: {
				acme: { headers: { Authorization: "Bearer acme" } },
				beta: { headers: { Authorization: "Bearer beta", "X-Api-Key": "beta-key" } },
			},
		};
		const submitted = {
			servers: { acme: { $from: "acme", headers: { Authorization: "" } } },
		};
		const { moves, deletes } = secretMoves(stored, submitted, SECRETS);
		expect([...moves]).toEqual([]);
		expect(deletes).toEqual([
			"servers/beta/headers/Authorization",
			"servers/beta/headers/X-Api-Key",
		]);
	});

	it("array entry identity uses x-sigrun-key", () => {
		const stored = { providers: [{ id: "acme", label: "Acme", clientSecret: "" }] };
		// The array item's identity is the value of its x-sigrun-key property.
		const { plain, writes } = splitSecrets(
			{ providers: [{ id: "acme", label: "Acme", clientSecret: "acme-secret" }] },
			SECRETS,
		);
		expect([...writes]).toEqual([["providers/acme/clientSecret", "acme-secret"]]);
		expect(plain).toEqual({ providers: [{ id: "acme", label: "Acme" }] });

		// A submitted entry resolves against the identity it was loaded under.
		const renamed = splitSecrets(
			{ providers: [{ id: "acme-2", $from: "acme", clientSecret: "rotated" }] },
			SECRETS,
		);
		expect([...renamed.writes]).toEqual([["providers/acme/clientSecret", "rotated"]]);

		const moved = secretMoves(
			stored,
			{ providers: [{ id: "acme-2", $from: "acme" }] },
			SECRETS,
		);
		expect([...moved.moves]).toEqual([
			["providers/acme/clientSecret", "providers/acme-2/clientSecret"],
		]);

		// An entry with no identity at all is not addressable: nothing is
		// written under a key that could collide with a sibling.
		expect(splitSecrets({ providers: [{ label: "New" }] }, SECRETS).writes.size).toBe(0);
	});
});

describe("fillSecrets", () => {
	it("fill restores nested values", async () => {
		// The stored file keeps a table-of-secrets' names with no values.
		const settings = {
			accept: "application/json",
			servers: { acme: { url: "https://acme.example.invalid", headers: { Authorization: "" } } },
			providers: [{ id: "acme", label: "Acme" }],
		};
		const stored = new Map([
			["token", "acme-top-level"],
			["servers/acme/headers/Authorization", "Bearer acme"],
			["providers/acme/clientSecret", "acme-secret"],
		]);
		const filled = await fillSecrets(settings, SECRETS, async (key) => stored.get(key));
		expect(filled).toEqual({
			accept: "application/json",
			token: "acme-top-level",
			servers: {
				acme: { url: "https://acme.example.invalid", headers: { Authorization: "Bearer acme" } },
			},
			providers: [{ id: "acme", label: "Acme", clientSecret: "acme-secret" }],
		});
		// Missing secrets stay absent (never an empty string).
		const partial = await fillSecrets(settings, SECRETS, async () => undefined);
		expect(partial).toEqual(settings);
		// The settings object handed in is never mutated.
		expect(settings.servers.acme.headers).toEqual({ Authorization: "" });
		expect(Object.hasOwn(settings, "token")).toBe(false);
	});
});

describe("secretStatuses", () => {
	it("statuses never contain values", async () => {
		const settings = {
			servers: { acme: { headers: { Authorization: "Bearer acme" } } },
			providers: [{ id: "acme", clientSecret: "acme-secret" }],
		};
		const sources = new Map<string, "stored" | "env">([
			["servers/acme/headers/Authorization", "stored"],
			["providers/acme/clientSecret", "env"],
		]);
		const statuses = await secretStatuses(settings, SECRETS, async (key) => sources.get(key));
		expect(statuses).toEqual({
			"servers/acme/headers/Authorization": "stored",
			"providers/acme/clientSecret": "env",
		});
		// The status is the whole payload: no value is ever echoed.
		const rendered = JSON.stringify(statuses);
		expect(rendered).not.toContain("acme-secret");
		expect(rendered).not.toContain("Bearer acme");
		expect(new Set(Object.values(statuses))).toEqual(new Set(["stored", "env"]));

		// A key the channels compose from an entry's SAVED identity resolves
		// (a renamed entry still shows its secret as set) …
		const renamed = await secretStatuses(
			{ providers: [{ id: "acme-2", $from: "acme", clientSecret: "" }] },
			SECRETS,
			async (key) => sources.get(key),
		);
		expect(renamed).toEqual({ "providers/acme/clientSecret": "env" });

		// … while a new unsaved entry has no identity, so nothing is looked up
		// and its secret shows as not set.
		const unsaved = await secretStatuses(
			{ providers: [{ label: "New", clientSecret: "" }] },
			SECRETS,
			async (key) => sources.get(key),
		);
		expect(unsaved).toEqual({});
	});
});
