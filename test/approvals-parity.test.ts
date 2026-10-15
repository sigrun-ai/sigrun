/**
 * The security-parity e2e (spec slice 3, Task 7 step 1(2)): an
 * approvals-gated tool called FROM A CODEMODE SCRIPT prompts — the nested
 * `executeTool` runs the ToolTask `beforeTool` hooks, which is the whole
 * point of the pi-durable 1.2.0 upgrade (1.0.2's in-VM tool surface never
 * reached the harness hooks).
 *
 * This is a PARITY LOCK on shipped behavior (the pieces exist: pi-durable
 * 1.2.0 + the approvals extension + the codemode extension), not new
 * behavior — so unlike the loader-collision test it is expected to pass
 * once wired; its value is that it fails if any layer stops routing nested
 * calls through the hooks.
 *
 * Harness shape: a REAL pi-durable Harness (faux provider) with THREE
 * extensions installed together —
 *   - the codemode extension, imported from its own repo's built dist via
 *     relative path (`~/repos/sigrun-ext-codemode/dist/index.js`; the
 *     worktree sits one level deeper than the main checkout, hence four
 *     `..` segments — the loader contract's factory, called directly), and
 *   - the approvals extension (the sigrun tree's devDependency pin), with
 *     `onPending` capturing what the gate surfaces (the record the server
 *     lists as the approval prompt),
 *   - a fixture extension owning `guarded_write`, a tool that is NOT in the
 *     default policy's readOnlyTools, so the gate holds it.
 *
 * The proof: while the script awaits `tools.guarded_write(...)`, the tool
 * has NOT run (execution held), the pending record exists with parent
 * linkage (nested call ids embed the parent call's id:
 * `<parentCallId>/<key>`), and after `decide("allow")` the tool runs and
 * the script's return value carries the tool's result back through the
 * codemode tool result.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, beforeAll } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	type ModelRef,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
// Sibling repos by path (publish prep: the git devDependency pins are gone;
// the built dists are the dev shape — the same shape the e2e harness uses
// for the memory extension). Static TS imports can't resolve outside the
// package root, so the wirings load at runtime via dynamic import in
// beforeAll and are typed minimally here.
type ApprovalRecord = { callId: string; toolName: string };
type ApprovalsWiring = {
	extension: import("@earendil-works/pi-durable").Extension<import("@earendil-works/pi-durable").ToolRegistration>;
	decide: (root: unknown, callId: string, decision: "allow" | "deny", context: unknown, reason?: string) => Promise<void>;
	listPending: (root: unknown, context: unknown) => Promise<ApprovalRecord[]>;
	close?: () => Promise<void>;
};
type ApprovalsFactory = (options?: {
	policy?: { readonly readOnlyTools: readonly string[]; readonly gateWrites: boolean };
	onPending?: (record: ApprovalRecord, context: unknown) => Promise<void> | void;
}) => ApprovalsWiring;

let createApprovals: ApprovalsFactory;
let DEFAULT_APPROVAL_POLICY: { readonly readOnlyTools: readonly string[]; readonly gateWrites: boolean };
// The codemode extension from its own repo (built dist; the loader-shaped
// factory, called directly — same contract the loader would call).
let createCodemodeWiring: () => {
	extension: import("@earendil-works/pi-durable").Extension<import("@earendil-works/pi-durable").ToolRegistration>;
	close?: () => Promise<void>;
};

beforeAll(async () => {
	// Dynamic import via a COMPUTED specifier: tsc can't statically resolve
	// sibling-repo paths (no tsconfig paths for them), so a literal
	// specifier errors TS2307 even on a dynamic import; a runtime-built
	// path (tsx/vitest resolve it fine) keeps the typecheck silent.
	const approvalsPath = join(
		import.meta.dirname,
		"../../sigrun-ext-approvals/dist/index.js",
	);
	const approvalsMod = (await import(approvalsPath)) as unknown as {
		createApprovals: ApprovalsFactory;
		DEFAULT_APPROVAL_POLICY: {
			readonly readOnlyTools: readonly string[];
			readonly gateWrites: boolean;
		};
	};
	({ createApprovals, DEFAULT_APPROVAL_POLICY } = approvalsMod);
	const codemodePath = join(
		import.meta.dirname,
		"../../sigrun-ext-codemode/dist/index.js",
	);
	const codemodeMod = (await import(codemodePath)) as unknown as {
		createCodemodeWiring: typeof createCodemodeWiring;
	};
	({ createCodemodeWiring } = codemodeMod);
});

/** A marker the guarded tool's execute writes into the script's result. */
const GUARDED_MARKER = "guarded-write-executed";

test("an approvals-gated tool called from a codemode script PROMPTS, then runs after allow", { timeout: 60_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-approvals-parity-"));
	const workspace = join(dir, "workspace");
	await mkdir(workspace, { recursive: true });

	// What the approvals gate surfaces (the record the server lists as the
	// prompt; the hook's onPending sink is the prompt channel).
	const surfaced: { callId: string; toolName: string }[] = [];
	// Whether the gated tool's execute has run — the gate must hold it.
	let guardedRan = false;

	// NOTE (discovered by this test's first run): the DEFAULT policy gates the
	// `codemode` tool itself — it is not in readOnlyTools — so the OUTER
	// model-issued codemode call prompts before any script runs. That is
	// defense-in-depth and correct, but this test isolates the NESTED-call
	// mechanism, so the policy here passes `codemode` (read-only for the
	// model's part: the script's own tool calls still gate — that IS the
	// test) exactly like a deployment that policy-lists codemode.
	const approvals = createApprovals({
		policy: {
			readOnlyTools: [...DEFAULT_APPROVAL_POLICY.readOnlyTools, "codemode"],
			gateWrites: true,
		},
		onPending: async (record: ApprovalRecord) => {
			surfaced.push({ callId: record.callId, toolName: record.toolName });
		},
	});

	/** Not in DEFAULT_APPROVAL_POLICY.readOnlyTools → the gate holds it. */
	const guardedWrite = defineTool({
		name: "guarded_write",
		description: "Gated test tool: approvals must hold this until decided.",
		parameters: Type.Object({
			path: Type.String({ description: "Path the tool pretends to write." }),
		}),
		async execute(args: { path: string }) {
			guardedRan = true;
			// The pi-durable 1.2.0 tool-result contract: `output` content blocks
			// (a bare string return renders as empty output — the nested call's
			// `structuredOutput` is derived from `output`).
			return {
				output: [{ type: "text" as const, text: `${GUARDED_MARKER}:${args.path}` }],
			};
		},
	});
	const guardedExtension = defineExtension({
		name: "sigrun.test-guarded",
		tools: [guardedWrite],
	});

	const codemode = createCodemodeWiring();

	const fauxProviderModule = await import("@earendil-works/pi-ai/providers/faux");
	const faux = fauxProviderModule.fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"codemode",
				{
					code: 'const r = await tools.guarded_write({ path: "notes.txt" });\nreturn `script got: ${r}`;',
				},
				{ id: "call-1" },
			),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done after script"),
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const defaultModel: ModelRef = { provider: "faux", modelId: "m" };

	const registry = createRegistry();
	registry.install(codemode.extension);
	registry.install(approvals.extension);
	registry.install(guardedExtension);

	const harness = await Harness.open(
		await openNodeSqliteStorage(join(dir, "sigrun.db")),
		{
			models,
			registry,
			env: () => new NodeExecutionEnv({ cwd: workspace }),
		},
		BACKGROUND_CONTEXT,
	);
	try {
		harness.resume();
		const root = await harness.root(BACKGROUND_CONTEXT, {
			agent: { model: defaultModel },
		});
		const submission = await root.submit(
			{ type: "input", content: "run the script" },
			BACKGROUND_CONTEXT,
		);

		// The gate holds the nested call: wait for the approvals surface to
		// see it (the hook long-polls every 25ms; the sink fires once).
		const waitDeadline = Date.now() + 30_000;
		while (surfaced.length === 0 && Date.now() < waitDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0]?.toolName).toBe("guarded_write");
		// Parent linkage: a nested call's id embeds its parent call's id
		// (`<parentCallId>/<key>`), so a "/" proves the call arrived at the
		// hook WITH its parent — the codemode call — not as a detached call.
		expect(surfaced[0]?.callId).toContain("/");
		// The whole point: the gated tool has NOT executed while pending.
		expect(guardedRan).toBe(false);

		// Decide, and the held call proceeds; the submission then settles.
		await approvals.decide(
			root,
			surfaced[0]!.callId,
			"allow",
			BACKGROUND_CONTEXT,
		);
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");
		await root.waitForIdle(BACKGROUND_CONTEXT);

		// The tool ran, and the script received its result.
		expect(guardedRan).toBe(true);
		const page = await root.entries({}, 50, undefined, BACKGROUND_CONTEXT);
		const transcript = JSON.stringify(page.items);
		const codemodeResult = page.items.find((entry) =>
			entry.model?.some(
				(message) =>
					(message as { role?: string; toolName?: string }).role ===
						"toolResult" &&
					(message as { role?: string; toolName?: string }).toolName ===
						"codemode",
			),
		);
		expect(codemodeResult).toBeDefined();
		const message = codemodeResult!.model![0] as {
			isError: boolean;
			content: { type: string; text?: string }[];
		};
		expect(message.isError).toBe(false);
		expect(
			message.content.some(
				(block) => block.text?.includes(`script got: ${GUARDED_MARKER}:notes.txt`),
			),
		).toBe(true);
		// And the pending record is gone from the approvals surface.
		expect(await approvals.listPending(root, BACKGROUND_CONTEXT)).toEqual([]);
		// Belt: the transcript carries the nested call too.
		expect(transcript).toContain("guarded_write");
	} finally {
		await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
		await codemode.close?.().catch(() => undefined);
		await rm(dir, { recursive: true, force: true });
	}
});
