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
	toHarnessEnv,
	type WorkspacePreferences,
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

		// The env is upstream's local Node env: `FileSystem.id` is pinned by
		// upstream's contract (equal ids see the same files at the same paths,
		// whatever their cwd).
		const second = await service.forConversation(conversation, prefs);
		expect(env.id).toBe("node:local");
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

test("the harness env builder applies the conversation's agent cwd", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-workspace-"));
	const projectDir = join(workspacePath, "project");
	try {
		await mkdir(projectDir);
		await writeFile(join(projectDir, "task.txt"), "from the project dir");
		const service = createWorkspaceService();
		const prefs = defaultWorkspacePrefs(workspacePath);
		const build = toHarnessEnv(service, prefs);

		// pi-durable passes the committed `agent.cwd` through `EnvTarget.cwd`
		// and applies nothing itself (verified: dist/harness/harness.js:137-138);
		// the adapter must root the env there so tools see the conversation dir.
		const env = await build(
			{ conversationId: ROOT_CONVERSATION_ID, cwd: "project", read: null as never },
			BACKGROUND_CONTEXT,
		);
		if (env === undefined) throw new Error("expected the env builder to return an env");
		// A relative agent cwd is a directory within the workspace.
		expect(env.cwd).toBe(join(workspacePath, "project"));

		// Relative file operations resolve against the applied cwd.
		const read = await env.readTextFile("task.txt", BACKGROUND_CONTEXT);
		expect(read.ok).toBe(true);
		if (!read.ok) throw read.error;
		expect(read.value).toBe("from the project dir");

		// Without a cwd the env stays at the workspace root.
		const rooted = await build(
			{ conversationId: ROOT_CONVERSATION_ID, read: null as never },
			BACKGROUND_CONTEXT,
		);
		if (rooted === undefined) throw new Error("expected the env builder to return an env");
		expect(rooted.cwd).toBe(workspacePath);

		// An absolute cwd is honored exactly as given.
		const absolute = await build(
			{ conversationId: ROOT_CONVERSATION_ID, cwd: projectDir, read: null as never },
			BACKGROUND_CONTEXT,
		);
		if (absolute === undefined) throw new Error("expected the env builder to return an env");
		expect(absolute.cwd).toBe(projectDir);
		const absoluteRead = await absolute.readTextFile("task.txt", BACKGROUND_CONTEXT);
		expect(absoluteRead.ok).toBe(true);
		if (!absoluteRead.ok) throw absoluteRead.error;
		expect(absoluteRead.value).toBe("from the project dir");
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("workspaceService rejects a non-local default workspace", async () => {
	const service = createWorkspaceService();
	// v1 knows only the static local workspace; anything else fails loud.
	const prefs = {
		defaultWorkspace: { type: "remote", path: "x" },
	} as never as WorkspacePreferences;
	await expect(service.forConversation(conversation, prefs)).rejects.toThrow(
		/Unsupported workspace type/,
	);
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
