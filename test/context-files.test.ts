/**
 * Task 4: context-file prompt sections (spec §3 context files row).
 *
 * `SOUL.md` in the workspace renders the `persona` section and `AGENTS.md`
 * the `workspace-instructions` section, read through the conversation's
 * `ExecutionEnv` (`PromptInput.env`). A missing file is an empty section
 * (render → undefined), never an error; a malformed read (any `FileError`
 * other than `not_found`) fails loud.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import { contextFilesExtension } from "../src/harness/sections/context-files.js";
import {
	createWorkspaceService,
	defaultWorkspacePrefs,
} from "../src/harness/workspace.js";

/** Minimal conversation stand-in (T3 seam): only the id matters to v1. */
const conversation = { id: ROOT_CONVERSATION_ID };

/**
 * The `PromptInput` the harness passes a section render: the fields the
 * context-file sections read are `env` (the conversation's `ExecutionEnv`)
 * and `conversationId`. `agent`, `shown`, and `read` are not read; they are
 * typed loosely below because building a real `Agent` is not needed to test
 * file reads.
 */
function promptInput(
	env: ExecutionEnv | undefined,
	conversationId = ROOT_CONVERSATION_ID,
) {
	return {
		conversationId,
		agent: null as never,
		env,
		shown: {},
		read: null as never,
	};
}

/** Look up one section of the extension by key. */
function sectionByKey(key: string) {
	const found = contextFilesExtension.sections?.find(
		(section) => section.key === key,
	);
	if (found === undefined) throw new Error(`no section keyed ${key}`);
	return found;
}

/**
 * Workspace-level tests exercise the sections directly: the render contract
 * (env read, not_found → undefined) is this module's own; the harness-level
 * tests below prove the same sections render end-to-end through generation.
 */
test("missing SOUL.md renders an absent persona section", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-cf-"));
	try {
		const service = createWorkspaceService();
		const env = await service.forConversation(
			conversation,
			defaultWorkspacePrefs(workspacePath),
		);
		const persona = sectionByKey("persona");
		const text = await persona.render(promptInput(env), BACKGROUND_CONTEXT);
		expect(text).toBeUndefined();
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("a present SOUL.md renders its body as the persona section", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-cf-"));
	try {
		const soul = "You are sigrun. Speak plainly and keep promises.\n";
		await writeFile(join(workspacePath, "SOUL.md"), soul);
		const service = createWorkspaceService();
		const env = await service.forConversation(
			conversation,
			defaultWorkspacePrefs(workspacePath),
		);
		const persona = sectionByKey("persona");
		const text = await persona.render(promptInput(env), BACKGROUND_CONTEXT);
		expect(text).toBe(soul);
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("a present AGENTS.md renders the workspace-instructions section", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-cf-"));
	try {
		const agents = "Run npm test before declaring work done.\n";
		await writeFile(join(workspacePath, "AGENTS.md"), agents);
		const service = createWorkspaceService();
		const env = await service.forConversation(
			conversation,
			defaultWorkspacePrefs(workspacePath),
		);
		const instructions = sectionByKey("workspace-instructions");
		const text = await instructions.render(
			promptInput(env),
			BACKGROUND_CONTEXT,
		);
		expect(text).toBe(agents);
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("an absent AGENTS.md renders an absent workspace-instructions section", async () => {
	// AGENTS.md's empty case mirrors SOUL.md's: no file, no section.
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-cf-"));
	try {
		await writeFile(join(workspacePath, "SOUL.md"), "persona only\n");
		const service = createWorkspaceService();
		const env = await service.forConversation(
			conversation,
			defaultWorkspacePrefs(workspacePath),
		);
		const instructions = sectionByKey("workspace-instructions");
		const text = await instructions.render(
			promptInput(env),
			BACKGROUND_CONTEXT,
		);
		expect(text).toBeUndefined();
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("a malformed read fails loud instead of rendering empty", async () => {
	// The designed empty section is the *missing file* (not_found). Any other
	// FileError is a real failure and must throw, not silently disappear.
	const persona = sectionByKey("persona");
	const env = {
		cwd: "/",
		id: "test",
		readTextFile: () =>
			Promise.resolve({
				ok: false,
				// Mirrors upstream `FileError` completely: code + message.
				error: { code: "permission_denied", message: "EACCES: permission denied" },
			}),
	} as unknown as ExecutionEnv;
	// The message names the file and carries the underlying error.
	await expect(
		persona.render(promptInput(env), BACKGROUND_CONTEXT),
	).rejects.toThrow(/read SOUL\.md/);
	await expect(
		persona.render(promptInput(env), BACKGROUND_CONTEXT),
	).rejects.toThrow(/permission denied/);
});

test("without an environment the sections render empty, not error", async () => {
	// `PromptInput.env` is undefined when the harness has no env option;
	// reading files then is impossible: empty section, never an error.
	const persona = sectionByKey("persona");
	const instructions = sectionByKey("workspace-instructions");
	expect(
		await persona.render(promptInput(undefined), BACKGROUND_CONTEXT),
	).toBeUndefined();
	expect(
		await instructions.render(promptInput(undefined), BACKGROUND_CONTEXT),
	).toBeUndefined();
});

test("openHarness installs the context-file sections into the registry", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-harness-"));
	const workspacePath = join(dir, "workspace");
	try {
		await mkdir(workspacePath, { recursive: true });
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: workspacePath,
		});
		const opened = await openHarness(config);
		try {
			const sections = opened.registry
				.snapshot()
				.sections()
				.map((entry) => entry.section.key);
			expect(sections).toContain("persona");
			expect(sections).toContain("workspace-instructions");

			// The installed extension is the one this module defines.
			const extension = opened.registry
				.snapshot()
				.extension(contextFilesExtension.name);
			expect(extension).toBe(contextFilesExtension);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("harness generation includes the persona section from SOUL.md", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-harness-"));
	const workspacePath = join(dir, "workspace");
	try {
		await mkdir(workspacePath, { recursive: true });
		await writeFile(join(workspacePath, "SOUL.md"), "generation persona\n");
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: workspacePath,
		});
		// Scrubbed env keeps the test hermetic: no ambient OPENAI_API_KEY (or
		// sibling credential) may leak into the degenerate provider and turn the
		// deliberate request failure into a real network call. Sections render
		// in `prepare` before the provider call either way.
		const opened = await openHarness(config, { env: {} });
		try {
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: opened.defaultModel },
			});
			const submission = await root.submit(
				{ type: "input", content: "hello" },
				BACKGROUND_CONTEXT,
			);
			await submission.wait(BACKGROUND_CONTEXT);
			const view = await root.context(BACKGROUND_CONTEXT);
			const system = view.messages.find(
				(message) => message.role === "system",
			);
			expect(system).toBeDefined();
			// The persona section carries the SOUL body (tagged by upstream's
			// default `tag: true`); AGENTS.md is absent, so no section.
			const sections = (system as { sections?: Record<string, string> })
				.sections;
			expect(sections?.persona).toContain("generation persona");
			expect(sections?.["workspace-instructions"]).toBeUndefined();
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});