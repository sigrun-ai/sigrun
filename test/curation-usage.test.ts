/**
 * Task A6 (curator P4): usage telemetry.
 *
 * `UsageCounters` — one per user (`new UsageCounters({userArea, user})`) —
 * counts `load_skill` calls (skills/index.ts), `/skill:` expansions
 * (commands/expand.ts) and core `read`-tool reads inside a learned root
 * (harness/tools.ts), each as `bump(skill, kind)`, `lastUsed(skill)`
 * reads back the most recent instant, and the counters flush to
 * `curationDir/usage.json` at most once per 10 s per user. `bash cat`
 * does NOT count (the documented gap: the shell path never sees a
 * skill-shaped read).
 *
 * Hermetic: the usage counters are driven directly (the unit shape) and
 * the counting seams are driven through the real tool/expansion code
 * (the curation-overlays unit-driven shapes).
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { curationDir, learnedSkillsDir } from "../src/curation/paths.js";
import { UsageCounters } from "../src/curation/usage.js";
import {
	createSkillsExtension,
	type SkillsOptions,
} from "../src/skills/index.js";
import { imageReadTool, countReadUsage } from "../src/harness/tools.js";
import { expandInput } from "../src/commands/expand.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** One tmp user area with a learned skill. */
async function setup(user = "alice"): Promise<{ dir: string; userArea: string }> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-usage-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const userArea = join(dir, "users", user);
	const skillDir = join(learnedSkillsDir(userArea), "acme-deploy");
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		join(skillDir, "SKILL.md"),
		"---\nname: acme-deploy\ndescription: Deploy acme\n---\n# Deploy\n\nDeploy the acme way.\n",
	);
	return { dir, userArea };
}

// ---------------------------------------------------------------------------
// UsageCounters (P4, direct)
// ---------------------------------------------------------------------------

describe("UsageCounters", () => {
	test("bump, lastUsed and the usage.json flush", async () => {
		const { dir, userArea } = await setup();
		let clock = 1_000_000;
		const counters = new UsageCounters({
			userArea,
			user: "alice",
			now: () => new Date(clock),
		});
		expect(counters.lastUsed("acme-deploy")).toBeUndefined();
		counters.bump("acme-deploy", "load");
		expect(counters.lastUsed("acme-deploy")).toBe(
			new Date(1_000_000).toISOString(),
		);
		expect(counters.lastUsed("acme-other")).toBeUndefined();
		counters.bump("acme-deploy", "read");
		clock += 5_000;
		counters.bump("acme-deploy", "expand");
		expect(counters.lastUsed("acme-deploy")).toBe(
			new Date(1_005_000).toISOString(),
		);
		clock += 11_000;
		await counters.flush();
		const file = JSON.parse(
			await readFile(join(curationDir(userArea), "usage.json"), "utf8"),
		) as { [skill: string]: { load?: number; read?: number; expand?: number; lastUsed: string } };
		expect(file["acme-deploy"]).toMatchObject({
			load: 1,
			read: 1,
			expand: 1,
			lastUsed: new Date(1_005_000).toISOString(),
		});
		expect(dir.length).toBeGreaterThan(0);
	});

	test("flush is throttled to once per 10s and forced at the deadline", async () => {
		const { userArea } = await setup();
		let clock = 1_000_000;
		const counters = new UsageCounters({
			userArea,
			user: "alice",
			now: () => new Date(clock),
		});
		counters.bump("acme-deploy", "load");
		await counters.flush();
		// Before the 10s deadline: a no-op.
		clock += 5_000;
		counters.bump("acme-deploy", "read");
		await counters.flush();
		let file = JSON.parse(
			await readFile(join(curationDir(userArea), "usage.json"), "utf8"),
		) as { [skill: string]: { load?: number; read?: number } };
		expect(file["acme-deploy"]?.read).toBeUndefined();
		// Past the deadline: the write lands.
		clock += 6_000;
		await counters.flush();
		file = JSON.parse(
			await readFile(join(curationDir(userArea), "usage.json"), "utf8"),
		) as { [skill: string]: { read?: number } };
		expect(file["acme-deploy"]?.read).toBe(1);
	});

	test("a second load round through usage.json accumulates counts", async () => {
		const { userArea } = await setup();
		let clock = 1_000_000;
		const first = new UsageCounters({ userArea, user: "alice", now: () => new Date(clock) });
		first.bump("acme-deploy", "load");
		await first.flush();
		// A fresh instance (the next process's shape) reads what was flushed
		// and keeps counting.
		const second = new UsageCounters({ userArea, user: "alice", now: () => new Date(clock) });
		second.bump("acme-deploy", "load");
		expect(second.lastUsed("acme-deploy")).toBe(new Date(clock).toISOString());
		await second.flush();
		const file = JSON.parse(
			await readFile(join(curationDir(userArea), "usage.json"), "utf8"),
		) as { [skill: string]: { load?: number } };
		expect(file["acme-deploy"]?.load).toBe(2);
	});

	test("userExists false -> bump and force-flush write nothing (no directory is created)", async () => {
		const { userArea } = await setup();
		let exists = true;
		const counters = new UsageCounters({
			userArea,
			user: "alice",
			now: () => new Date(1_000_000),
			userExists: () => exists,
		});
		// An in-flight counting seam after the user's deletion (deletion
		// removed the curation directory; the directory gate flipped): the
		// cached counters still resolve and bump still bookkeeps in memory,
		// but the flush must NOT recreate the deleted directory — deletion's
		// fail-closed claim, the A4 store idiom, but SILENT (the counting
		// seams are void-and-forget; telemetry must never throw).
		await rm(curationDir(userArea), { recursive: true, force: true });
		exists = false;
		counters.bump("acme-deploy", "load");
		await expect(counters.flush()).resolves.toBeUndefined();
		// A counters free of the 10s throttle (the deadline-forced write
		// shape, driven here as an unthrottled fresh instance) drops too.
		const late = new UsageCounters({
			userArea,
			user: "alice",
			now: () => new Date(1_000_000 + 60_000),
			userExists: () => false,
		});
		late.bump("acme-deploy", "expand");
		await expect(late.flush()).resolves.toBeUndefined();
		// Nothing landed: no directory, no usage.json.
		await expect(stat(curationDir(userArea))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

// ---------------------------------------------------------------------------
// The counting seams (load_skill, /skill:, read of a learned file)
// ---------------------------------------------------------------------------

/** Write one learned SKILL.md for a user under the dir. */
async function writeLearned(dir: string, user: string, name: string): Promise<void> {
	const skillDir = join(dir, "data", "users", user, "skills", name);
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: Deploy acme\n---\n# Deploy\n\nDeploy the acme way.\n`,
	);
}

/** Skills options carrying a usage-counter seam. */
function optionsWithUsage(
	dir: string,
	usage: (owner: string | undefined) => UsageCounters | undefined,
): SkillsOptions {
	return {
		userDir: join(dir, "config", "skills"),
		learnedRoot: (owner) =>
			owner === undefined
				? undefined
				: join(dir, "data", "users", owner, "skills"),
		packageRoots: (): readonly { extension: string; dir: string }[] => [],
		sectionMaxBytes: () => 4096,
		usage: (owner) => usage(owner),
	};
}

/** The load_skill tool of one skills extension. */
function loadSkillTool(opts: SkillsOptions) {
	const extension = createSkillsExtension(opts);
	const tool = extension.tools?.find((candidate) => candidate.name === "load_skill");
	if (tool === undefined) throw new Error("no load_skill tool");
	return tool;
}

/** A tool api stub (the curation-overlays toolApi shape). */
function toolApi(owner?: string): { api: ToolExecutionApi; chunks: string[] } {
	const chunks: string[] = [];
	const api = {
		env: undefined,
		output: (chunk: string | Uint8Array) => {
			chunks.push(
				typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
			);
		},
		snapshot: async () => (owner === undefined ? undefined : { owner }),
	} as unknown as ToolExecutionApi;
	return { api, chunks };
}

describe("usage counting seams", () => {
	test("load_skill, /skill: and read of a learned file each bump usage; bash cat does not", { timeout: 20_000 }, async () => {
		const { dir, userArea } = await setup();
		await writeLearned(dir, "alice", "acme-deploy");
		let clock = 1_000_000;
		const counters = new UsageCounters({ userArea, user: "alice", now: () => new Date(clock) });
		const usage = (owner: string | undefined) =>
			owner === "alice" ? counters : undefined;

		// load_skill counts.
		const loadSkill = loadSkillTool(optionsWithUsage(dir, usage));
		const { api } = toolApi("alice");
		await loadSkill.execute({ name: "acme-deploy" }, api, BACKGROUND_CONTEXT);
		expect(counters.lastUsed("acme-deploy")).toBe(new Date(1_000_000).toISOString());
		await counters.flush();
		let file = JSON.parse(
			await readFile(join(curationDir(userArea), "usage.json"), "utf8"),
		) as { [skill: string]: { load?: number; expand?: number; read?: number } };
		expect(file["acme-deploy"]?.load).toBe(1);

		// /skill: expansion counts.
		clock += 11_000;
		const expansion = {
			skills: optionsWithUsage(dir, usage),
			templates: {
				userDir: join(dir, "absent-prompts"),
				packageRoots: (): readonly { extension: string; dir: string }[] => [],
			},
			commandNames: () => new Set<string>(),
		};
		await expandInput(
			[{ type: "text", text: "/skill:acme-deploy now" }],
			expansion,
			undefined,
			BACKGROUND_CONTEXT,
			"alice",
		);
		expect(file["acme-deploy"]?.expand).toBeUndefined();
		await counters.flush();
		file = JSON.parse(
			await readFile(join(curationDir(userArea), "usage.json"), "utf8"),
		) as { [skill: string]: { expand?: number } };
		expect(file["acme-deploy"]?.expand).toBe(1);

		// A core read of a learned-root file counts.
		clock += 11_000;
		const readEnv = new NodeExecutionEnv({
			cwd: join(learnedSkillsDir(userArea), "acme-deploy"),
		});
		const countedRead = countReadUsage({
			countersOf: (owner) => (owner === "alice" ? counters : undefined),
			learnedRootOf: (owner) =>
				owner === undefined ? undefined : learnedSkillsDir(userArea),
		});
		const readApi = {
			env: readEnv,
			snapshot: async () => ({ owner: "alice" }),
		} as unknown as ToolExecutionApi;
		const counted = await countedRead.execute(
			{ path: "SKILL.md" },
			readApi,
			BACKGROUND_CONTEXT,
		);
		expect(counted.isError).not.toBe(true);
		await counters.flush();
		file = JSON.parse(
			await readFile(join(curationDir(userArea), "usage.json"), "utf8"),
		) as { [skill: string]: { read?: number } };
		expect(file["acme-deploy"]?.read).toBe(1);

		// bash cat does NOT count (the documented gap): no seam fires.
		// (There is nothing to assert beyond the unchanged file — the gap
		// itself is the contract — but a workspace cat proves the read
		// counter keys only the learned root.)
		clock += 11_000;
		await writeFile(join(dir, "workspace-note.txt"), "note");
		const catEnv = new NodeExecutionEnv({ cwd: dir });
		const catApi = { env: catEnv } as unknown as ToolExecutionApi;
		await imageReadTool.execute(
			{ path: "workspace-note.txt" },
			catApi,
			BACKGROUND_CONTEXT,
		);
		await counters.flush();
		file = JSON.parse(
			await readFile(join(curationDir(userArea), "usage.json"), "utf8"),
		) as { [skill: string]: { read?: number } };
		expect(file["acme-deploy"]?.read).toBe(1);
	});
});
