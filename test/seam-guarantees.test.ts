/**
 * Seam-guarantee pins (core hardening §6.7, spec rules 1 + 3): the
 * guarantees the ask-user and warden ports rely on, each locked by a
 * test so a future change (or a pi-durable upgrade) that opens a bypass
 * fails HERE, not in someone's port.
 *
 * 1. **Core installs no tool that answers interactions.** Interactions
 *    are answered only through the host seam / HTTP route (the
 *    principal-carrying paths that stamp `answeredByUser`); if a core
 *    tool ever gains the ability to answer one, the model could settle
 *    pending human decisions itself. The pin: the EXACT core-installed
 *    tool-name list from a zero-extension `openHarness` — a new core
 *    tool must update this list deliberately.
 *
 * 2. **Codemode's script-internal calls run `ToolTask` hooks as nested
 *    calls with `call.parent`.** pi-durable's codemode routes nested
 *    `tools.*` calls through `api.executeTool`, so every nested call is
 *    indistinguishable from a model-issued one to `beforeTool`/`afterTool`
 *    hooks (gating extensions hold nested calls too). The pin: a recorder
 *    extension's `beforeTool` must see the script's `tools.ls({})` WITH
 *    `parent.callId` equal to the codemode call's id.
 *
 * Test 2 is a regression pin of upstream behavior — it is EXPECTED to
 * pass from the start; its value is catching an upgrade that opens a
 * bypass (e.g. codemode switching away from `executeTool`).
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxToolCall,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	createRegistry,
	defineExtension,
	Harness,
	hook,
	ToolTask,
	type ModelRef,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import { searchToolsExtension } from "../src/harness/tools.js";

function configWith(dir: string) {
	return loadConfig({
		SIGRUN_MODEL: "openai/gpt-4o",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
}

test("core installs no tool that answers interactions", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-seam-tools-"));
	try {
		const opened = await openHarness(configWith(dir), { env: {} });
		try {
			// The exact core surface: coding tools (read/write/edit/bash),
			// search tools (find/grep/ls), and load_skill. Context-files,
			// the no-op memory default, and model guidance contribute
			// sections only; nothing here can answer a pending interaction.
			const names = opened.registry
				.snapshot()
				.tools()
				.map((entry) => entry.tool.name)
				.sort();
			expect(names).toEqual([
				"bash",
				"edit",
				"find",
				"grep",
				"load_skill",
				"ls",
				"read",
				"write",
			]);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("codemode nested calls reach beforeTool with call.parent", { timeout: 60_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-seam-codemode-"));
	const workspace = join(dir, "workspace");
	await mkdir(workspace, { recursive: true });

	// What the recorder's beforeTool sees: name + the nested-call parent
	// (absent for model-issued calls like the codemode call itself).
	const recorded: {
		name: string;
		parent?: { taskId: unknown; callId: string };
	}[] = [];
	const recorder = defineExtension({
		name: "sigrun.test-nested-recorder",
		hooks: [
			hook(ToolTask, {
				beforeTool(call) {
					recorded.push({
						name: call.name,
						...(call.parent === undefined
							? {}
							: {
									parent: {
										taskId: call.parent.taskId,
										callId: call.parent.callId,
									},
								}),
					});
				},
			}),
		],
	});

	const sandbox = new CodemodeSandbox();
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	// One model-issued codemode call (id "call-1"); its script calls the
	// CORE `ls` tool once — the nested call the pin is about.
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall(
				"codemode",
				{
					code: "await tools.ls({});\nreturn 'script done';",
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
	registry.install(createCodemodeExtension({ sandbox }));
	registry.install(searchToolsExtension);
	registry.install(recorder);

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
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");

		// The model-issued codemode call arrived as a normal top-level call.
		expect(recorded.some((entry) => entry.name === "codemode")).toBe(true);
		// The nested ls call arrived WITH its parent — the codemode call —
		// so a gating extension's beforeTool held it like any other call.
		const nested = recorded.find((entry) => entry.name === "ls");
		expect(nested).toBeDefined();
		expect(nested?.parent?.callId).toBe("call-1");
	} finally {
		await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
		sandbox.close().catch(() => undefined);
		await rm(dir, { recursive: true, force: true });
	}
});
