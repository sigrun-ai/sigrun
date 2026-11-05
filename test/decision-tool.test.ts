/**
 * Warden Task 7: the core-owned `decision_evaluate` tool — installed by
 * the `sigrun.decisions` extension when the registry lists ≥ 1 decision
 * model at boot, absent otherwise; gated live on `decisions.tool` (read
 * per execution, so a settings write flips it with no restart);
 * validating requests through `validateDecisionRequest` and returning
 * the DecisionResult as text plus `structuredOutput`.
 *
 * The tool executes straight from the registry snapshot (the
 * decisions-loader boot pattern: `fixture-decision-provider` for
 * `acme-judge`, `expectHostBridge: true` is NOT needed — no host call).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { DecisionResult } from "@sigrun/shared/decisions";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { seededIdentity } from "./helpers/identity.js";
import {
	calls as providerCalls,
	resetDecisionProvider,
} from "./fixtures/fixture-decision-provider/index.js";

const PROVIDER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-decision-provider", "index.js"),
).href;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

interface Rig {
	opened: OpenedHarness;
	dir: string;
}

async function boot(
	specifiers: readonly string[],
	env: Record<string, string> = {},
): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-decision-tool-"));
	const config = loadConfig({
		SIGRUN_MODEL: "openai/gpt-4o",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		env,
		identity: await seededIdentity(dir),
		builtins: false,
		settingsDir: dir,
		extensionSpecifiers: specifiers,
	});
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	return { opened, dir };
}

/** The installed `decision_evaluate` registration, else undefined. */
function decisionTool(opened: OpenedHarness): ToolRegistration | undefined {
	return opened.registry
		.snapshot()
		.tools()
		.find((entry) => entry.tool.name === "decision_evaluate")?.tool;
}

/**
 * The minimal execution context: `decision_evaluate` reads nothing from
 * `api`/`context` (its inputs are args + the boot-captured slots), so
 * the stubs stay empty by design.
 */
async function run(tool: ToolRegistration, args: unknown) {
	const api = {} as ToolExecutionApi;
	const context = {} as Context;
	return tool.execute(args as never, api, context);
}

test("decision_evaluate is absent when no decision model exists", async () => {
	const rig = await boot([]);
	expect(decisionTool(rig.opened)).toBeUndefined();
});

test("decision_evaluate refuses while decisions.tool is false, and answers once it is true (no restart)", async () => {
	resetDecisionProvider();
	const rig = await boot([PROVIDER], { TYPESAFE_API_KEY: "acme-env-key" });
	const opened = rig.opened;
	const tool = decisionTool(opened);
	expect(tool).toBeDefined();
	if (tool === undefined) throw new Error("unreachable");
	const args = { state: "acme", questions: { q: { type: "noul" } } };

	// Default: the tool setting is off — an explicit refusal, no provider call.
	const refused = await run(tool, args);
	expect(refused.isError).toBe(true);
	expect(JSON.stringify(refused.output)).toContain(
		"decision_evaluate is disabled; set decisions.tool to true",
	);
	expect(providerCalls).toHaveLength(0);

	// Flip the live setting (a file write — the settings store re-reads it).
	await writeFile(
		join(rig.dir, "settings.json"),
		JSON.stringify({ decisions: { tool: true } }),
	);
	const allowed = await run(tool, args);
	expect(allowed.isError).toBeUndefined();
	expect(providerCalls).toHaveLength(1);
	const result = JSON.parse(
		(allowed.output as { type: "text"; text: string }[])[0]!.text,
	) as DecisionResult;
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("unreachable");
	expect(result.model).toBe("acme-judge/judge-1");
	expect(result.answers.q).toMatchObject({ type: "noul", noul: 0.5 });
	// The structured channel carries the same result object.
	expect(allowed.structuredOutput).toMatchObject({ ok: true, model: "acme-judge/judge-1" });
	// The provider sees the core caller stamp, not the tool name.
	expect(providerCalls[0]?.caller).toBe("sigrun");
});

test("decision_evaluate returns the DecisionResult and refuses 33 questions with over_limits", async () => {
	resetDecisionProvider();
	const rig2 = await boot([PROVIDER], { TYPESAFE_API_KEY: "acme-env-key" });
	await writeFile(
		join(rig2.dir, "settings.json"),
		JSON.stringify({ decisions: { tool: true } }),
	);
	const tool2 = decisionTool(rig2.opened);
	if (tool2 === undefined) throw new Error("unreachable");
	const questions = Object.fromEntries(
		Array.from({ length: 33 }, (_, i) => [`q${i}`, { type: "noul" }]),
	);
	const result = await run(tool2, { state: "acme", questions });
	const parsed = JSON.parse(
		(result.output as { type: "text"; text: string }[])[0]!.text,
	) as DecisionResult;
	expect(parsed.ok).toBe(false);
	if (parsed.ok) throw new Error("unreachable");
	expect(parsed.code).toBe("over_limits");
	expect(result.structuredOutput).toMatchObject({ ok: false, code: "over_limits" });
	expect(providerCalls).toHaveLength(0);
});
