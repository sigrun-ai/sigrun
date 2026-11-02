/**
 * Task A5 (curator P2 part 2): per-user overlays on non-learned skills.
 *
 * An overlay attaches to a skill the user does NOT own (workspace, user
 * dir, package roots) for ONE user, keyed by root kind + skill name (+
 * the workspace path for workspace skills). `load_skill` and
 * `/skill:name` serve the upstream body followed by the overlay under
 * `OVERLAY_HEADING`; the skills section lists the skill ONCE,
 * unchanged. An overlay never applies to a learned skill (put throws).
 * A vanished upstream stops serving but keeps the overlay, marked
 * orphaned by `markOrphans`, and removable. Overlay changes append
 * `overlay` action entries to the SAME per-user feed the SkillStore
 * owns (A4).
 *
 * Hermetic: tmp dirs, unit-driven extension + expansion (the
 * skills.test.ts / commands-expand.test.ts shapes).
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type {
	PromptInput,
	ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { curationDir, learnedSkillsDir } from "../src/curation/paths.js";
import { SkillStore } from "../src/curation/store.js";
import {
	OVERLAY_HEADING,
	OverlayStore,
	hashSkill,
	resolveUpstream,
	type OverlayKey,
} from "../src/curation/overlays.js";
import {
	SKILLS_SECTION_KEY,
	createSkillsExtension,
	type SkillsOptions,
} from "../src/skills/index.js";
import { expandInput } from "../src/commands/expand.js";
import {
	createWorkspaceService,
	defaultWorkspacePrefs,
} from "../src/harness/workspace.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface Setup {
	readonly dir: string;
	readonly userArea: string;
	readonly feed: SkillStore;
	readonly overlays: OverlayStore;
}

/** One user's store pair (the skill feed store + its overlay store). */
async function setup(user = "alice"): Promise<Setup> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-overlays-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const userArea = join(dir, "users", user);
	const feed = new SkillStore({
		userArea,
		user,
		now: () => new Date(),
		nameTakenElsewhere: async () => undefined,
		userExists: () => true,
	});
	const overlays = new OverlayStore({
		userArea,
		user,
		userExists: () => true,
		feed,
	});
	return { dir, userArea, feed, overlays };
}

const UPSTREAM_BODY = "# Deploy\n\nDeploy the acme way.\n";

/** Write one user-dir skill (the deployment's root); returns its root. */
async function writeUserDirSkill(
	dir: string,
	name = "acme-deploy",
): Promise<string> {
	const skillDir = join(dir, "config", "skills", name);
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: Deploy acme\n---\n${UPSTREAM_BODY}`,
	);
	return join(dir, "config", "skills");
}

/** Write one learned skill under the user's own area (never overlaid). */
async function writeLearnedSkill(
	userArea: string,
	name = "acme-deploy",
): Promise<void> {
	const skillDir = join(learnedSkillsDir(userArea), name);
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: Deploy acme\n---\n# Learned\n\nOwn copy.\n`,
	);
}

/** The user-dir key most tests overlay. */
function userDirKey(name = "acme-deploy"): OverlayKey {
	return { root: "user dir", skill: name };
}

/** Skills options over one user dir, optionally with overlay stores. */
function skillOptions(
	userDir: string,
	overlays?: (owner: string | undefined) => OverlayStore | undefined,
): SkillsOptions {
	return {
		userDir,
		packageRoots: (): readonly { extension: string; dir: string }[] => [],
		sectionMaxBytes: () => 4096,
		...(overlays === undefined ? {} : { overlays }),
	};
}

// ---------------------------------------------------------------------------
// load_skill / section helpers (the skills.test.ts shapes)
// ---------------------------------------------------------------------------

type SkillsExtension = ReturnType<typeof createSkillsExtension>;

function loadSkillTool(ext: SkillsExtension) {
	const found = ext.tools?.find((tool) => tool.name === "load_skill");
	if (found === undefined) throw new Error("no load_skill tool");
	return found;
}

function sectionByKey(key: string, ext: SkillsExtension) {
	const found = ext.sections?.find((section) => section.key === key);
	if (found === undefined) throw new Error(`no section keyed ${key}`);
	return found;
}

/**
 * A fake `ToolExecutionApi` carrying what `load_skill` reads: the env,
 * the retained-output buffer, and a DocumentReader snapshot stub that
 * resolves the conversation owner (the A3 helper shape).
 */
function toolApi(env: ExecutionEnv | undefined, owner?: string) {
	const chunks: string[] = [];
	const api = {
		env,
		output: (chunk: string | Uint8Array) => {
			chunks.push(
				typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
			);
		},
		snapshot: async () => (owner === undefined ? undefined : { owner }),
	} as unknown as ToolExecutionApi;
	return { api, chunks };
}

/** The `PromptInput` a section render receives (owner via the read stub). */
function promptInput(env: ExecutionEnv | undefined, owner?: string): PromptInput {
	return {
		conversationId: ROOT_CONVERSATION_ID,
		agent: null as never,
		env,
		shown: {},
		read:
			owner === undefined
				? (null as never)
				: ({ snapshot: async () => ({ owner }) } as never),
	};
}

/** The conversation env for a temp workspace (an AgentExecutionEnv). */
async function workspaceEnv(workspacePath: string) {
	return createWorkspaceService().forConversation(
		{ id: ROOT_CONVERSATION_ID },
		defaultWorkspacePrefs(workspacePath),
	);
}

// ---------------------------------------------------------------------------
// Serving: load_skill and /skill:name
// ---------------------------------------------------------------------------

describe("overlay serving", () => {
	test("load_skill serves upstream body then the heading then the overlay", async () => {
		const { dir, userArea, feed, overlays } = await setup();
		const userDir = await writeUserDirSkill(dir);
		const entry = await overlays.put(
			userDirKey(),
			"Prefer the blue button.",
			hashSkill(UPSTREAM_BODY),
			{ actor: "curator", reviewId: "review-1" },
		);
		// The change went through the skill store's feed as an overlay entry.
		expect(entry).toMatchObject({
			action: "overlay",
			skill: "acme-deploy",
			actor: "curator",
			reviewId: "review-1",
		});
		expect(await feed.feed(1)).toEqual([entry]);
		// Storage: curationDir/overlays/<root>/<sha256-of-key>.json.
		const stored = await readdir(
			join(curationDir(userArea), "overlays", "user-dir"),
		);
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatch(/^[0-9a-f]{64}\.json$/);
		// Serving: body, heading, overlay — in that order.
		const ext = createSkillsExtension(
			skillOptions(userDir, (owner) => (owner === "alice" ? overlays : undefined)),
		);
		const { api, chunks } = toolApi(undefined, "alice");
		const result = await loadSkillTool(ext).execute(
			{ name: "acme-deploy" },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(result.isError).toBeUndefined();
		expect(chunks.join("")).toBe(
			`${UPSTREAM_BODY}\n${OVERLAY_HEADING}\n\nPrefer the blue button.`,
		);
	});

	test("a workspace-root overlay keys on the workspace path", async () => {
		const { overlays } = await setup();
		const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-overlays-ws-"));
		cleanups.push(() => rm(workspacePath, { recursive: true, force: true }));
		const skillDir = join(workspacePath, "skills", "deploy");
		await mkdir(skillDir, { recursive: true });
		const body = "# Workspace deploy\n\nCheck the pod.\n";
		await writeFile(
			join(skillDir, "SKILL.md"),
			`---\nname: deploy\ndescription: Deploy from the workspace\n---\n${body}`,
		);
		const env = await workspaceEnv(workspacePath);
		await overlays.put(
			{ root: "workspace", skill: "deploy", workspace: workspacePath },
			"Workspace note.",
			hashSkill(body),
			{ actor: "curator" },
		);
		const ext = createSkillsExtension(
			skillOptions(join(tmpdir(), "sigrun-overlays-absent-"), (owner) =>
				owner === "alice" ? overlays : undefined,
			),
		);
		const { api, chunks } = toolApi(env, "alice");
		await loadSkillTool(ext).execute({ name: "deploy" }, api, BACKGROUND_CONTEXT);
		expect(chunks.join("")).toBe(
			`${body}\n${OVERLAY_HEADING}\n\nWorkspace note.`,
		);
	});

	test("/skill:name expansion carries the overlay", async () => {
		const { dir, overlays } = await setup();
		const userDir = await writeUserDirSkill(dir);
		await overlays.put(userDirKey(), "Prefer the blue button.", hashSkill(UPSTREAM_BODY), {
			actor: "curator",
		});
		const expansion = {
			skills: skillOptions(userDir, (owner) =>
				owner === "alice" ? overlays : undefined,
			),
			templates: {
				userDir: join(dir, "absent-prompts"),
				packageRoots: (): readonly { extension: string; dir: string }[] => [],
			},
			commandNames: () => new Set<string>(),
		};
		const alice = await expandInput(
			[{ type: "text", text: "/skill:acme-deploy now" }],
			expansion,
			undefined,
			BACKGROUND_CONTEXT,
			"alice",
		);
		const text = alice.parts[0];
		expect(text?.type).toBe("text");
		const rendered = text?.type === "text" ? text.text : "";
		expect(rendered).toContain('<skill name="acme-deploy"');
		expect(rendered).toContain("Deploy the acme way.");
		expect(rendered).toContain(OVERLAY_HEADING);
		expect(rendered).toContain("Prefer the blue button.");
		expect(rendered).toContain("now");
		// The overlay text sits inside the block, before </skill>.
		expect(rendered.indexOf(OVERLAY_HEADING)).toBeGreaterThan(
			rendered.indexOf("Deploy the acme way."),
		);
		expect(rendered.indexOf("Prefer the blue button.")).toBeLessThan(
			rendered.indexOf("</skill>"),
		);
	});

	test("the skills section lists the skill once, unchanged", async () => {
		const { dir, overlays } = await setup();
		const userDir = await writeUserDirSkill(dir);
		await overlays.put(userDirKey(), "Prefer the blue button.", hashSkill(UPSTREAM_BODY), {
			actor: "curator",
		});
		const withOverlays = createSkillsExtension(
			skillOptions(userDir, (owner) => (owner === "alice" ? overlays : undefined)),
		);
		const without = createSkillsExtension(skillOptions(userDir));
		const text = await sectionByKey(
			SKILLS_SECTION_KEY,
			withOverlays,
		).render(promptInput(undefined, "alice"), BACKGROUND_CONTEXT);
		const plain = await sectionByKey(
			SKILLS_SECTION_KEY,
			without,
		).render(promptInput(undefined, "alice"), BACKGROUND_CONTEXT);
		expect(text).toBe(plain);
		expect(text?.split("- acme-deploy:")).toHaveLength(2);
		expect(text).not.toContain(OVERLAY_HEADING);
	});
});

// ---------------------------------------------------------------------------
// Store rules
// ---------------------------------------------------------------------------

describe("OverlayStore rules", () => {
	test("an overlay never applies to a learned skill (put throws)", async () => {
		const { userArea, feed, overlays } = await setup();
		await writeLearnedSkill(userArea);
		await expect(
			overlays.put(userDirKey(), "note", hashSkill("x"), { actor: "curator" }),
		).rejects.toThrow(/learned/);
		// Nothing was written: no overlay file, no feed entry.
		await expect(
			readdir(join(curationDir(userArea), "overlays")),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(await feed.feed(10)).toEqual([]);
	});

	test("overlay for a vanished upstream is not served, is orphaned, and is removable", async () => {
		const { dir, userArea, feed, overlays } = await setup();
		const userDir = await writeUserDirSkill(dir);
		const key = userDirKey();
		await overlays.put(key, "Prefer the blue button.", hashSkill(UPSTREAM_BODY), {
			actor: "curator",
		});
		const ext = createSkillsExtension(
			skillOptions(userDir, (owner) => (owner === "alice" ? overlays : undefined)),
		);
		// The upstream vanished: load_skill errors unknown skill.
		await rm(join(userDir, "acme-deploy"), { recursive: true, force: true });
		const vanished = await loadSkillTool(ext).execute(
			{ name: "acme-deploy" },
			toolApi(undefined, "alice").api,
			BACKGROUND_CONTEXT,
		);
		expect(vanished.isError).toBe(true);
		// markOrphans records when the upstream went absent.
		const now = "2026-11-01T00:00:00.000Z";
		await overlays.markOrphans(() => false, now);
		expect(await overlays.list()).toEqual([
			expect.objectContaining({ key, orphanedSince: now }),
		]);
		// The overlay is KEPT on disk.
		expect(
			await readdir(join(curationDir(userArea), "overlays", "user-dir")),
		).toHaveLength(1);
		// The upstream returns: the orphan mark clears and serving resumes.
		await writeUserDirSkill(dir);
		await overlays.markOrphans(() => true, "2026-11-02T00:00:00.000Z");
		const [restored] = await overlays.list();
		expect(restored).toMatchObject({ key });
		expect("orphanedSince" in restored!).toBe(false);
		// remove deletes the overlay and records it in the feed.
		const removed = await overlays.remove(key, { actor: "user" });
		expect(removed).toMatchObject({ action: "overlay", skill: "acme-deploy", actor: "user" });
		expect(await overlays.list()).toEqual([]);
		expect(await overlays.get(key)).toBeUndefined();
		expect((await feed.feed(10)).map((entry) => entry.action)).toEqual([
			"overlay",
			"overlay",
		]);
	});

	test("resolveUpstream returns the new hash after the upstream file changes", async () => {
		const { dir } = await setup();
		const userDir = await writeUserDirSkill(dir);
		const key = userDirKey();
		const first = await resolveUpstream(key, undefined, BACKGROUND_CONTEXT, {
			userDir,
		});
		expect(first).toMatchObject({ hash: hashSkill(first!.body) });
		expect(first?.body).toContain("Deploy the acme way.");
		await writeFile(
			join(userDir, "acme-deploy", "SKILL.md"),
			"---\nname: acme-deploy\ndescription: Deploy acme\n---\n# Deploy\n\nDeploy differently.\n",
		);
		const second = await resolveUpstream(key, undefined, BACKGROUND_CONTEXT, {
			userDir,
		});
		expect(second?.hash).not.toBe(first?.hash);
		expect(second?.body).toContain("Deploy differently.");
		// A workspace key resolves through the conversation env.
		const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-overlays-ws-"));
		cleanups.push(() => rm(workspacePath, { recursive: true, force: true }));
		const skillDir = join(workspacePath, "skills", "deploy");
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			join(skillDir, "SKILL.md"),
			"---\nname: deploy\ndescription: Deploy from the workspace\n---\n# Deploy\n\nFrom the workspace.\n",
		);
		const env = await workspaceEnv(workspacePath);
		const wsKey: OverlayKey = {
			root: "workspace",
			skill: "deploy",
			workspace: workspacePath,
		};
		const ws = await resolveUpstream(wsKey, env, BACKGROUND_CONTEXT);
		expect(ws?.body).toContain("From the workspace.");
		// An absent upstream resolves undefined.
		expect(
			await resolveUpstream(
				{ root: "user dir", skill: "gone" },
				undefined,
				BACKGROUND_CONTEXT,
				{ userDir },
			),
		).toBeUndefined();
	});

	test("bob never sees alice's overlay", async () => {
		const alice = await setup("alice");
		const bob = await setup("bob");
		const userDir = await writeUserDirSkill(alice.dir);
		await alice.overlays.put(
			userDirKey(),
			"Prefer the blue button.",
			hashSkill(UPSTREAM_BODY),
			{ actor: "curator" },
		);
		const ext = createSkillsExtension(
			skillOptions(userDir, (owner) =>
				owner === "alice"
					? alice.overlays
					: owner === "bob"
						? bob.overlays
						: undefined,
			),
		);
		const tool = loadSkillTool(ext);
		const aliceRun = toolApi(undefined, "alice");
		await tool.execute({ name: "acme-deploy" }, aliceRun.api, BACKGROUND_CONTEXT);
		expect(aliceRun.chunks.join("")).toContain("Prefer the blue button.");
		const bobRun = toolApi(undefined, "bob");
		await tool.execute({ name: "acme-deploy" }, bobRun.api, BACKGROUND_CONTEXT);
		expect(bobRun.chunks.join("")).toBe(UPSTREAM_BODY);
		// Bob's own area has no overlay state at all.
		expect(await bob.overlays.list()).toEqual([]);
		// And expansion is the same story.
		const expansion = {
			skills: skillOptions(userDir, (o: string | undefined) =>
				o === "alice" ? alice.overlays : bob.overlays,
			),
			templates: {
				userDir: join(alice.dir, "absent-prompts"),
				packageRoots: (): readonly { extension: string; dir: string }[] => [],
			},
			commandNames: () => new Set<string>(),
		};
		const bobExpand = await expandInput(
			[{ type: "text", text: "/skill:acme-deploy" }],
			expansion,
			undefined,
			BACKGROUND_CONTEXT,
			"bob",
		);
		const bobText = bobExpand.parts[0];
		expect(bobText?.type === "text" ? bobText.text : "").not.toContain(
			OVERLAY_HEADING,
		);
	});

	test("userExists false throws user removed and writes nothing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-overlays-gone-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const userArea = join(dir, "users", "alice");
		const feed = new SkillStore({
			userArea,
			user: "alice",
			now: () => new Date(),
			nameTakenElsewhere: async () => undefined,
			userExists: () => false,
		});
		const overlays = new OverlayStore({
			userArea,
			user: "alice",
			userExists: () => false,
			feed,
		});
		await expect(overlays.put(userDirKey(), "n", "h", { actor: "curator" })).rejects.toThrow(
			"user removed",
		);
		await expect(overlays.get(userDirKey())).rejects.toThrow("user removed");
		await expect(overlays.list()).rejects.toThrow("user removed");
		await expect(overlays.remove(userDirKey(), { actor: "user" })).rejects.toThrow(
			"user removed",
		);
		await expect(
			overlays.markOrphans(() => true, "2026-11-01T00:00:00.000Z"),
		).rejects.toThrow("user removed");
	});
});
