import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import {
	createWorkspaceService,
	defaultWorkspacePrefs,
} from "../src/harness/workspace.js";

/**
 * Minimal conversation stand-in for the seam: the static workspace only needs
 * the conversation's id (the real pi-durable `Conversation` satisfies this).
 */
const conversation = { id: ROOT_CONVERSATION_ID };

test("workspaceService resolves the static local workspace for a conversation", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-workspace-"));
	try {
		const prefs = defaultWorkspacePrefs(workspacePath);
		const service = createWorkspaceService();
		const env = await service.forConversation(conversation, prefs);

		// The spec's static shape: `{ defaultWorkspace: { type: "local", path } }`.
		expect(prefs.defaultWorkspace).toEqual({
			type: "local",
			path: workspacePath,
		});

		// A local env's FileSystem id is stable across calls (equal ids see
		// the same files at the same paths, whatever their cwd).
		const second = await service.forConversation(conversation, prefs);
		expect(env.id).toBeTruthy();
		expect(second.id).toBe(env.id);

		// The env is rooted at the configured workspace directory.
		expect(env.cwd).toBe(workspacePath);

		// App C.1: the filesystem capability is the real upstream one.
		expect(typeof env.listDir).toBe("function");
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("workspace env lists and reads files in the workspace root", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-workspace-"));
	try {
		await writeFile(join(workspacePath, "note.md"), "hello sigrun");
		const service = createWorkspaceService();
		const env = await service.forConversation(
			conversation,
			defaultWorkspacePrefs(workspacePath),
		);

		const listed = await env.listDir(workspacePath, BACKGROUND_CONTEXT);
		expect(listed.ok).toBe(true);
		if (!listed.ok) throw listed.error;
		expect(listed.value.map((info) => info.name)).toContain("note.md");

		const read = await env.readTextFile("note.md", BACKGROUND_CONTEXT);
		expect(read.ok).toBe(true);
		if (!read.ok) throw read.error;
		expect(read.value).toBe("hello sigrun");
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("openHarness wires the workspace env builder into HarnessOptions", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-harness-"));
	const workspacePath = join(dir, "workspace");
	try {
		await mkdir(workspacePath);
		const config = loadConfig({
			SIGRUN_MODEL: "openai/gpt-4o",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: workspacePath,
		});

		const opened = await openHarness(config);
		try {
			// `HarnessOptions.env` is what pi-durable calls per tool call with
			// `EnvTarget = { conversationId, cwd?, read }` (verified against the
			// pinned version); `opened.envBuilder` is the very function
			// `openHarness` passed there.
			const target = { conversationId: ROOT_CONVERSATION_ID, read: opened.harness };
			const built = await opened.envBuilder(target, BACKGROUND_CONTEXT);
			if (built === undefined) {
				throw new Error("expected the env builder to return an env");
			}
			expect(built.id).toBeTruthy();
			expect(built.cwd).toBe(workspacePath);
			expect(typeof built.listDir).toBe("function");

			// The builder is called per tool call, so a second call must
			// produce an env with the same stable filesystem id.
			const again = await opened.envBuilder(target, BACKGROUND_CONTEXT);
			expect(again?.id).toBe(built.id);
			expect(again?.cwd).toBe(workspacePath);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});