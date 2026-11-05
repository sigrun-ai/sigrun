/**
 * Knowledge C7 Task 2 (loader + host wiring): the `publishedHooks`
 * factory-result field end to end — loader validation (quarantine on a
 * malformed declaration), collection attributed to the slug with the
 * `builtin` flag, the seam host's `publishedHooks` member (get/call
 * against the boot-built registry, caller = the rekeyed slug read at
 * call time), and the registry-ready deferred (a call issued from a
 * factory body resolves once loading finishes).
 *
 * Hermetic pattern (loader-notice-actions.test.ts): fixtures boot via
 * `openHarness` with `builtins: false`; fixture module-side records are
 * shared with the test through the one file:// module instance.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { seededIdentity } from "./helpers/identity.js";
import {
	runs as providerRuns,
	resetHookProvider,
} from "./fixtures/fixture-hook-provider/index.js";
import {
	calls as callerCalls,
	callFromCaller,
	pending as callerPending,
	resetHookCaller,
} from "./fixtures/fixture-hook-caller/index.js";
import {
	altRuns,
	resetHookProviderAlt,
} from "./fixtures/fixture-hook-provider-alt/index.js";

/** The hook provider (`acme-recall`, hook `recall.echo`). */
const PROVIDER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-hook-provider", "index.js"),
).href;
/** The caller (`acme-notes` via `createFixtureHookCaller`). */
const CALLER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-hook-caller", "index.js"),
).href;
/** The duplicate-name provider (quarantines). */
const PROVIDER_DUP = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-hook-provider-dup", "index.js"),
).href;
/** The compile-failing provider (quarantines). */
const PROVIDER_BAD_SCHEMA = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-hook-provider-badschema", "index.js"),
).href;
/** The slow provider (timeout under a small SIGRUN_PUBLISHED_HOOK_DEADLINE). */
const PROVIDER_SLOW = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-hook-provider-slow", "index.js"),
).href;
/** The second `recall.echo` provider (the shadowed one). */
const PROVIDER_ALT = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-hook-provider-alt", "index.js"),
).href;

function configWith(dir: string, extraEnv: Record<string, string> = {}) {
	return loadConfig({
		SIGRUN_MODEL: "openai/gpt-4o",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		...extraEnv,
	});
}

/** Boot the harness with the fixture specifiers; close + clean up after. */
async function withOpenedHarness(
	specifiers: readonly string[],
	run: (opened: OpenedHarness) => Promise<void>,
	options: { env?: Record<string, string>; extraBuiltins?: readonly string[] } = {},
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-published-hooks-"));
	let opened: OpenedHarness | undefined;
	try {
		opened = await openHarness(configWith(dir, options.env ?? {}), {
			env: {},
			identity: await seededIdentity(dir),
			// Hermetic: pin the fixtures' outcomes, not the built-in surface
			// (except the configured-beats-built-in case, which adds ONE
			// fixture built-in explicitly).
			builtins: options.extraBuiltins === undefined ? false : undefined,
			extraBuiltins: options.extraBuiltins,
			extensionSpecifiers: specifiers,
		});
		await run(opened);
	} finally {
		await opened?.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	}
}

test("a provider and a caller load; the call returns ok with the provider's slug", async () => {
	resetHookProvider();
	resetHookCaller();
	await withOpenedHarness([PROVIDER, CALLER], async (opened) => {
		expect(opened.extensionOutcomes).toEqual([
			{ name: "acme-recall", status: "ok" },
			{ name: "acme-notes", status: "ok" },
		]);
		// The host surface sees the provider (post-load lookup).
		const host = opened.seamHosts.get("acme-notes");
		expect(host).toBeDefined();
		expect(host?.publishedHooks.get("recall.echo")).toMatchObject({
			provider: "acme-recall",
		});
		const result = await callFromCaller("recall.echo", { text: "hello" });
		expect(result.status).toBe("ok");
		if (result.status !== "ok") throw new Error("unreachable");
		expect(result.provider).toBe("acme-recall");
		expect(result.value).toEqual({ echo: "hello", caller: "acme-notes" });
		// The provider saw the caller's REKEYED slug, never the specifier.
		expect(providerRuns).toHaveLength(1);
		expect(providerRuns[0]?.caller).toBe("acme-notes");
	});
});

test("a call fired from the factory body waits for the registry and resolves ok", async () => {
	resetHookProvider();
	resetHookCaller();
	const EARLY_CALLER = pathToFileURL(
		join(import.meta.dirname, "fixtures", "fixture-hook-early-caller", "index.js"),
	).href;
	await withOpenedHarness([PROVIDER, EARLY_CALLER], async () => {
		expect(callerPending).toHaveLength(1);
		await Promise.all(callerPending);
		expect(callerCalls).toHaveLength(1);
		expect(callerCalls[0]?.status).toBe("ok");
		if (callerCalls[0]?.status !== "ok") throw new Error("unreachable");
		expect(callerCalls[0]?.provider).toBe("acme-recall");
	});
});

test("a duplicate name inside one extension quarantines it", async () => {
	await withOpenedHarness([PROVIDER_DUP], async (opened) => {
		expect(opened.extensionOutcomes).toHaveLength(1);
		expect(opened.extensionOutcomes[0]?.status).toBe("quarantined");
		expect(opened.extensionOutcomes[0]?.error).toContain("duplicate");
		// A quarantined provider claims nothing.
		expect(opened.publishedHooks()).toEqual([]);
	});
});

test("a schema that fails to compile quarantines the extension", async () => {
	await withOpenedHarness([PROVIDER_BAD_SCHEMA], async (opened) => {
		expect(opened.extensionOutcomes).toHaveLength(1);
		expect(opened.extensionOutcomes[0]?.status).toBe("quarantined");
		expect(opened.extensionOutcomes[0]?.error).toMatch(/compile|schema/i);
		expect(opened.publishedHooks()).toEqual([]);
	});
});

test("two configured providers: the first listed owns, the second is shadowed", async () => {
	resetHookProvider();
	resetHookProviderAlt();
	await withOpenedHarness([PROVIDER, PROVIDER_ALT], async (opened) => {
		expect(opened.extensionOutcomes).toEqual([
			{ name: "acme-recall", status: "ok" },
			{ name: "acme-recall-alt", status: "ok" },
		]);
		expect(opened.publishedHooks()).toEqual([
			{ name: "recall.echo", provider: "acme-recall", shadowed: ["acme-recall-alt"] },
		]);
		// The shadowed provider never runs.
		const host = opened.seamHosts.get("acme-recall-alt");
		const result = await host?.publishedHooks.call("recall.echo", { text: "hi" });
		expect(result?.status).toBe("ok");
		if (result?.status !== "ok") throw new Error("unreachable");
		expect(result.provider).toBe("acme-recall");
		expect(providerRuns).toHaveLength(1);
		expect(altRuns).toHaveLength(0);
	});
});

test("a configured provider beats a built-in provider of the same name", async () => {
	resetHookProvider();
	resetHookProviderAlt();
	// The ALT fixture loads as a BUILT-IN; the configured one must own.
	await withOpenedHarness([PROVIDER], async (opened) => {
		expect(opened.publishedHooks()).toEqual([
			{ name: "recall.echo", provider: "acme-recall", shadowed: ["acme-recall-alt"] },
		]);
	}, { extraBuiltins: [PROVIDER_ALT] });
});

test("a quarantined provider claims nothing: the call is absent", async () => {
	resetHookCaller();
	await withOpenedHarness([PROVIDER_DUP, CALLER], async () => {
		const result = await callFromCaller("recall.echo", { text: "hello" });
		expect(result.status).toBe("absent");
	});
});

test("SIGRUN_PUBLISHED_HOOK_DEADLINE=50 makes a slow provider fail with reason timeout", async () => {
	resetHookCaller();
	await withOpenedHarness([PROVIDER_SLOW, CALLER], async () => {
		const result = await callFromCaller("recall.echo", {});
		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("unreachable");
		expect(result.reason).toBe("timeout");
		expect(result.provider).toBe("acme-slow-hooks");
	}, { env: { SIGRUN_PUBLISHED_HOOK_DEADLINE: "50" } });
});

test("the caller is the rekeyed slug, not the load specifier", async () => {
	resetHookProvider();
	resetHookCaller();
	await withOpenedHarness([PROVIDER, CALLER], async (opened) => {
		// The seam host was pre-keyed on the PROVISIONAL slug derived from
		// the specifier (a file URL — "index" or "") and rekeyed in place
		// to the declared name; the stamped caller must be the final slug.
		expect(opened.seamHosts.get("acme-notes")).toBeDefined();
		await callFromCaller("recall.echo", { text: "whoami" });
		expect(providerRuns.at(-1)?.caller).toBe("acme-notes");
	});
});
