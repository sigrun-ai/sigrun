/**
 * Task 11: every-root discovery with safe reads (`src/skills/roots.ts`).
 *
 * `listAllRoots` lists EVERY root's skills (precedence order: workspace >
 * learned > user dir > packages in install order), losers included, with
 * shadowing info (`shadowedBy`), hidden flags, and `{error}` rows for
 * skills that fail the safety checks. `readSkillFile` / `listSupportFiles`
 * are the ONLY read paths the core/skills view uses: symlinks refused on
 * every path segment, real-path containment within the discovery root,
 * SKILL.md or references|templates|scripts|assets/<rel> only, 256 KiB cap
 * — so the host-privileged view can never show a file the agent's sandbox
 * could not read (confused-deputy anti-goal).
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
	type RootSkill,
	listAllRoots,
	listSupportFiles,
	readSkillFile,
} from "../src/skills/roots.js";

const created: string[] = [];

async function tempDir(label: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), label));
	created.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

/** Write one well-formed SKILL.md (or the whole body when `text` is given). */
async function writeSkill(
	root: string,
	dirName: string,
	fields: { name: string; description: string; hidden?: boolean },
	text?: string,
): Promise<void> {
	const dir = join(root, "skills", dirName);
	await mkdir(dir, { recursive: true });
	const content =
		text ??
		`---\nname: ${fields.name}\ndescription: ${fields.description}${fields.hidden === true ? "\ndisable-model-invocation: true" : ""}\n---\n\nBody of ${fields.name}.\n`;
	await writeFile(join(dir, "SKILL.md"), content);
}

/** Group the listed skills by root label, in list order. */
function byRoot(skills: readonly RootSkill[]): Map<string, RootSkill[]> {
	const grouped = new Map<string, RootSkill[]>();
	for (const skill of skills) {
		const bucket = grouped.get(skill.root) ?? [];
		bucket.push(skill);
		grouped.set(skill.root, bucket);
	}
	return grouped;
}

test("every root listed with shadowing", async () => {
	const workspace = await tempDir("sigrun-roots-ws-");
	const learned = await tempDir("sigrun-roots-learned-");
	const config = await tempDir("sigrun-roots-config-");
	const pkgA = await tempDir("sigrun-roots-pkga-");
	const pkgB = await tempDir("sigrun-roots-pkgb-");

	// The shared name exists in every root; the workspace wins.
	await writeSkill(workspace, "deploy", { name: "deploy", description: "workspace deploy" });
	await writeSkill(workspace, "ws-only", { name: "ws-only", description: "workspace only" });
	await writeSkill(learned, "acme-deploy", { name: "deploy", description: "learned deploy" });
	await writeSkill(learned, "learned-only", { name: "learned-only", description: "learned only" });
	await writeSkill(config, "acme-deploy", { name: "deploy", description: "config deploy" });
	await writeSkill(config, "config-only", { name: "config-only", description: "config only" });
	await writeSkill(pkgA, "acme-deploy", { name: "deploy", description: "package deploy" });
	await writeSkill(pkgB, "acme-deploy", { name: "deploy", description: "other package deploy" });

	const skills = await listAllRoots({
		workspace: join(workspace, "skills"),
		learned: join(learned, "skills"),
		userDir: join(config, "skills"),
		packageRoots: [
			{ extension: "acme.one", dir: join(pkgA, "skills") },
			{ extension: "acme.two", dir: join(pkgB, "skills") },
		],
	});

	const grouped = byRoot(skills);
	// Losers are INCLUDED, in precedence order: workspace > learned > user
	// dir > packages in install order.
	expect([...grouped.keys()]).toEqual(["workspace", "learned", "user dir", "package"]);
	expect(grouped.get("workspace")?.map((s) => s.name)).toEqual(["deploy", "ws-only"]);
	expect(grouped.get("learned")?.map((s) => s.name)).toEqual(["deploy", "learned-only"]);
	expect(grouped.get("user dir")?.map((s) => s.name)).toEqual(["config-only", "deploy"]);
	expect(grouped.get("package")?.map((s) => s.packageName)).toEqual(["acme.one", "acme.two"]);

	// The workspace entry wins; every loser names the root that shadowed it.
	expect(grouped.get("workspace")?.find((s) => s.name === "deploy")?.shadowedBy).toBeUndefined();
	expect(grouped.get("learned")?.find((s) => s.name === "deploy")?.shadowedBy).toBe("workspace");
	expect(grouped.get("user dir")?.find((s) => s.name === "deploy")?.shadowedBy).toBe("workspace");
	expect(grouped.get("package")?.find((s) => s.name === "deploy" && s.packageName === "acme.one")?.shadowedBy).toBe("workspace");
	expect(grouped.get("package")?.find((s) => s.name === "deploy" && s.packageName === "acme.two")?.shadowedBy).toBe("workspace");

	// Root anchors: rootDir is the discovery root; dir the skill directory.
	const wsDeploy = grouped.get("workspace")?.find((s) => s.name === "deploy");
	expect(wsDeploy?.rootDir).toBe(join(workspace, "skills"));
	expect(wsDeploy?.dir).toBe(join(workspace, "skills", "deploy"));
	expect(wsDeploy?.hidden).toBe(false);
	expect(wsDeploy?.error).toBeUndefined();

	// Unshadowed entries carry no shadowing info.
	expect(grouped.get("learned")?.find((s) => s.name === "learned-only")?.shadowedBy).toBeUndefined();
});

test("hidden skills are listed with hidden:true", async () => {
	const config = await tempDir("sigrun-roots-config-");
	await writeSkill(config, "plain", { name: "plain", description: "plain skill" });
	await writeSkill(config, "secret", { name: "secret", description: "hidden skill", hidden: true });

	const skills = await listAllRoots({
		userDir: join(config, "skills"),
		packageRoots: [],
	});

	expect(skills.map((skill) => [skill.name, skill.hidden])).toEqual([
		["plain", false],
		["secret", true],
	]);
});

test("symlinked SKILL.md is an error row and readSkillFile rejects", async () => {
	const config = await tempDir("sigrun-roots-config-");
	const outside = await tempDir("sigrun-roots-outside-");
	const secret = join(outside, "secret.txt");
	await writeFile(secret, "the sandbox must never see this\n");

	// A real skill next to it, so the root itself is fine.
	await writeSkill(config, "plain", { name: "plain", description: "plain skill" });
	// The trap: a skill dir whose SKILL.md is a symlink OUTSIDE the root.
	await mkdir(join(config, "skills", "trap"), { recursive: true });
	await symlink(secret, join(config, "skills", "trap", "SKILL.md"));

	const rootDir = join(config, "skills");
	const skills = await listAllRoots({ userDir: rootDir, packageRoots: [] });

	const trap = skills.find((skill) => skill.dir === join(rootDir, "trap"));
	expect(trap).toBeDefined();
	expect(trap?.error).toMatch(/symlink/);
	// The plain skill still listed normally.
	expect(skills.find((skill) => skill.name === "plain")?.error).toBeUndefined();

	// The view's read path refuses as well — the target's content is never served.
	await expect(readSkillFile(rootDir, "trap", "SKILL.md")).rejects.toThrow(/symlink/);
});

test("a symlinked skill dir is an error row", async () => {
	const config = await tempDir("sigrun-roots-config-");
	const outside = await tempDir("sigrun-roots-outside-");
	// A fully-formed skill living OUTSIDE the root, linked in by directory.
	await writeSkill(outside, "skills", { name: "outside", description: "outside skill" });
	await writeSkill(config, "plain", { name: "plain", description: "plain skill" });
	await symlink(join(outside, "skills"), join(config, "skills", "sneaky"));

	const rootDir = join(config, "skills");
	const skills = await listAllRoots({ userDir: rootDir, packageRoots: [] });

	const sneaky = skills.find((skill) => skill.dir === join(rootDir, "sneaky"));
	expect(sneaky).toBeDefined();
	expect(sneaky?.error).toMatch(/symlink/);
	// Never read further: the outside skill's name/description leak nowhere.
	expect(skills.find((skill) => skill.name === "outside")).toBeUndefined();

	await expect(readSkillFile(rootDir, "sneaky", "SKILL.md")).rejects.toThrow(/symlink/);
	await expect(listSupportFiles(rootDir, "sneaky")).rejects.toThrow(/symlink/);
});

test("../ in a support path is refused", async () => {
	const config = await tempDir("sigrun-roots-config-");
	await writeSkill(config, "plain", { name: "plain", description: "plain skill" });

	const rootDir = join(config, "skills");
	await expect(readSkillFile(rootDir, "plain", "../outside.txt")).rejects.toThrow();
	await expect(readSkillFile(rootDir, "plain", "references/../../outside.txt")).rejects.toThrow();
	// Absolute and out-of-root paths are refused too.
	await expect(readSkillFile(rootDir, "plain", "/etc/passwd")).rejects.toThrow();
	// A file name outside the allowed support roots is refused.
	await expect(readSkillFile(rootDir, "plain", "notes/readme.md")).rejects.toThrow();
	// The skill segment itself cannot escape the skill directory.
	await expect(readSkillFile(rootDir, "..", "SKILL.md")).rejects.toThrow();

	// The allowed shapes read: SKILL.md and support-root files.
	await mkdir(join(rootDir, "plain", "references"), { recursive: true });
	await writeFile(join(rootDir, "plain", "references", "guide.md"), "guide\n");
	expect(await readSkillFile(rootDir, "plain", "SKILL.md")).toContain("Body of plain.");
	expect(await readSkillFile(rootDir, "plain", "references/guide.md")).toBe("guide\n");
});

test("a support file over 256 KiB is refused", async () => {
	const config = await tempDir("sigrun-roots-config-");
	await writeSkill(config, "plain", { name: "plain", description: "plain skill" });
	const rootDir = join(config, "skills");
	await mkdir(join(rootDir, "plain", "assets"), { recursive: true });
	await writeFile(join(rootDir, "plain", "assets", "big.bin"), "x".repeat(257 * 1024));

	await expect(readSkillFile(rootDir, "plain", "assets/big.bin")).rejects.toThrow(/256|large/i);
});

test("listSupportFiles lists files under the support roots", async () => {
	const config = await tempDir("sigrun-roots-config-");
	await writeSkill(config, "plain", { name: "plain", description: "plain skill" });
	const rootDir = join(config, "skills");
	await mkdir(join(rootDir, "plain", "references", "deep"), { recursive: true });
	await writeFile(join(rootDir, "plain", "references", "guide.md"), "guide\n");
	await writeFile(join(rootDir, "plain", "references", "deep", "nested.md"), "nested\n");
	await mkdir(join(rootDir, "plain", "scripts"), { recursive: true });
	await writeFile(join(rootDir, "plain", "scripts", "run.sh"), "#!/bin/sh\n");

	expect(await listSupportFiles(rootDir, "plain")).toEqual([
		"references/deep/nested.md",
		"references/guide.md",
		"scripts/run.sh",
	]);
	// A skill without support files lists nothing.
	expect(await listSupportFiles(rootDir, "missing")).toEqual([]);
});
