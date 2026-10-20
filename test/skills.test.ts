/**
 * Task 7: the skills convention (spec §3.2) — core-owned surface.
 * (Core hardening W5 Task 4: the surface grew from workspace-only to
 * three roots — workspace (ExecutionEnv), the user dir
 * `<configDir>/skills/`, and package-shipped skills — built through
 * `createSkillsExtension`; the precedence/cap tests live here, the
 * package/loader integration in packages.test.ts + loader.test.ts.)
 *
 * `skills/<dir>/SKILL.md` files under the conversation workspace are
 * scanned through the conversation's `ExecutionEnv` — `PromptInput.env`
 * for the `skills` section, `ToolExecutionApi.env` for `load_skill` — so
 * discovery follows the resolved workspace. The section lists each valid
 * skill's frontmatter name + description, capped (default 4KB, live via
 * `sectionMaxBytes`) with a truncation notice; `load_skill(name)` returns
 * the SKILL.md body. An absent or empty `skills/` directory is the
 * designed empty case (no section, no error). Frontmatter `name` and
 * `description` are required — a SKILL.md missing either (or the
 * frontmatter block) is skipped with a log; duplicate names resolve
 * first-wins with a log; a skill with `disable-model-invocation: true` is
 * hidden from the model entirely (not listed, unknown to load_skill).
 * Each entry carries the skill's path so the model can also read the
 * SKILL.md directly.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type {
	PromptInput,
	ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import {
	createWorkspaceService,
	defaultWorkspacePrefs,
} from "../src/harness/workspace.js";
import {
	SKILLS_SECTION_KEY,
	SKILLS_SECTION_LIMIT_BYTES,
	createSkillsExtension,
	type SkillsOptions,
} from "../src/skills/index.js";

/** One built skills extension (per-test overrides over inert defaults). */
type SkillsExtension = ReturnType<typeof createSkillsExtension>;

/**
 * Build the core skills extension with inert defaults: a user dir that
 * does not exist, no package roots, the default 4KB cap — tests override
 * exactly the root they exercise.
 */
function makeSkills(overrides: Partial<SkillsOptions> = {}): SkillsExtension {
	return createSkillsExtension({
		userDir:
			overrides.userDir ?? join(tmpdir(), "sigrun-skills-user-absent"),
		packageRoots:
			overrides.packageRoots ??
			((): readonly { extension: string; dir: string }[] => []),
		sectionMaxBytes:
			overrides.sectionMaxBytes ?? (() => SKILLS_SECTION_LIMIT_BYTES),
	});
}

/** Minimal conversation stand-in (T3 seam): only the id matters to v1. */
const conversation = { id: ROOT_CONVERSATION_ID };

/**
 * The `PromptInput` the harness passes a section render (same minimal shape
 * as the T4 context-file tests): only `env` is read here.
 */
function promptInput(env: ExecutionEnv | undefined): PromptInput {
	return {
		conversationId: ROOT_CONVERSATION_ID,
		agent: null as never,
		env,
		shown: {},
		read: null as never,
	};
}

/**
 * The default extension for the workspace-root tests: a user dir that
 * does not exist, no package roots, the default 4KB cap — each test that
 * exercises another root builds its own with `makeSkills({…})`.
 */
const defaultExt = makeSkills();

/** Look up one section of the extension by key. */
function sectionByKey(key: string, ext: SkillsExtension = defaultExt) {
	const found = ext.sections?.find(
		(section) => section.key === key,
	);
	if (found === undefined) throw new Error(`no section keyed ${key}`);
	return found;
}

/** The extension's `load_skill` tool registration. */
function loadSkillTool(ext: SkillsExtension = defaultExt) {
	const found = ext.tools?.find((tool) => tool.name === "load_skill");
	if (found === undefined) throw new Error("no load_skill tool");
	return found;
}

/**
 * A fake `ToolExecutionApi` carrying exactly what `load_skill` reads: the
 * env plus the retained-output buffer.
 */
function toolApi(env: ExecutionEnv | undefined) {
	const chunks: string[] = [];
	const api = {
		env,
		output: (chunk: string | Uint8Array) => {
			chunks.push(
				typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
			);
		},
	} as unknown as ToolExecutionApi;
	return { api, chunks };
}

/** The conversation env for a temp workspace, built the way the harness does. */
async function workspaceEnv(workspacePath: string) {
	return createWorkspaceService().forConversation(
		conversation,
		defaultWorkspacePrefs(workspacePath),
	);
}

/** Write one SKILL.md fixture into `skills/<dir>/`. */
async function writeSkill(
	workspacePath: string,
	dir: string,
	frontmatter: string,
	body = "# Skill body\n\nDo the thing.\n",
) {
	const skillDir = join(workspacePath, "skills", dir);
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		join(skillDir, "SKILL.md"),
		`---\n${frontmatter}\n---\n${body}`,
	);
}

/** UTF-8 byte length, the unit the section cap uses. */
function byteLength(text: string) {
	return new TextEncoder().encode(text).length;
}

test("an absent skills directory renders no section, not an error", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-skills-"));
	try {
		const skills = sectionByKey(SKILLS_SECTION_KEY);
		expect(
			await skills.render(
				promptInput(await workspaceEnv(workspacePath)),
				BACKGROUND_CONTEXT,
			),
		).toBeUndefined();
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("an empty skills directory renders no section", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-skills-"));
	try {
		await mkdir(join(workspacePath, "skills"));
		const skills = sectionByKey(SKILLS_SECTION_KEY);
		expect(
			await skills.render(
				promptInput(await workspaceEnv(workspacePath)),
				BACKGROUND_CONTEXT,
			),
		).toBeUndefined();
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("a valid skill lists its name and description in the section", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-skills-"));
	try {
		await writeSkill(
			workspacePath,
			"deploy",
			"name: deploy\ndescription: Run the deployment checklist end to end.",
		);
		const skills = sectionByKey(SKILLS_SECTION_KEY);
		const text = await skills.render(
			promptInput(await workspaceEnv(workspacePath)),
			BACKGROUND_CONTEXT,
		);
		expect(text).toBeDefined();
		expect(text).toContain("- deploy: Run the deployment checklist end to end.");
		// The entry carries the skill's path (T2a).
		expect(text).toContain("(skills/deploy)");
		// The header tells the model how to load a skill.
		expect(text).toContain("load_skill");
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("quoted frontmatter values are accepted", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-skills-"));
	try {
		await writeSkill(
			workspacePath,
			"quotes",
			'name: "quoted-skill"\ndescription: \'Values may be quoted.\'\nother: ignored',
		);
		const skills = sectionByKey(SKILLS_SECTION_KEY);
		const text = await skills.render(
			promptInput(await workspaceEnv(workspacePath)),
			BACKGROUND_CONTEXT,
		);
		expect(text).toContain("- quoted-skill: Values may be quoted.");
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("load_skill returns the SKILL.md body after the frontmatter", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-skills-"));
	try {
		const body = "# Deploy skill\n\n1. Check the checklist.\n2. Ship.\n";
		await writeSkill(
			workspacePath,
			"deploy",
			"name: deploy\ndescription: Run the deployment checklist.",
			body,
		);
		const tool = loadSkillTool();
		const { api, chunks } = toolApi(await workspaceEnv(workspacePath));
		const result = await tool.execute({ name: "deploy" }, api, BACKGROUND_CONTEXT);
		expect(result.isError).toBeUndefined();
		expect(chunks.join("")).toBe(body);
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("load_skill with an unknown name is an explicit error listing the available skills", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-skills-"));
	try {
		await writeSkill(
			workspacePath,
			"deploy",
			"name: deploy\ndescription: Run the deployment checklist.",
		);
		const tool = loadSkillTool();
		const { api } = toolApi(await workspaceEnv(workspacePath));
		const result = await tool.execute({ name: "nope" }, api, BACKGROUND_CONTEXT);
		expect(result.isError).toBe(true);
		const text = (result.output ?? [])
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("");
		expect(text).toContain("nope");
		expect(text).toContain("deploy");
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("a SKILL.md missing name, description, or the frontmatter block is skipped with a log", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-skills-"));
	try {
		await writeSkill(
			workspacePath,
			"no-name",
			"description: has a description but no name",
		);
		await writeSkill(
			workspacePath,
			"no-description",
			"name: orphan",
		);
		// No `---` delimiters at all: neither field can parse.
		const skillDir = join(workspacePath, "skills", "no-frontmatter");
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			join(skillDir, "SKILL.md"),
			"name: ghost\ndescription: no delimiters around me\n",
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const skills = sectionByKey(SKILLS_SECTION_KEY);
			expect(
				await skills.render(
					promptInput(await workspaceEnv(workspacePath)),
					BACKGROUND_CONTEXT,
				),
			).toBeUndefined();
			const logged = warn.mock.calls.map((call) => String(call[0]));
			expect(logged.some((line) => line.includes("no-name"))).toBe(true);
			expect(logged.some((line) => line.includes("no-description"))).toBe(true);
			expect(logged.some((line) => line.includes("no-frontmatter"))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("duplicate skill names resolve first-wins with a collision log", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-skills-"));
	try {
		// Directories sort alphabetically, so "alpha" is the earlier entry: its
		// content must win both the section and load_skill (first-wins, pi's
		// convention) and the later duplicate is logged.
		await writeSkill(
			workspacePath,
			"alpha",
			"name: demo\ndescription: first description",
			"# Alpha body\n",
		);
		await writeSkill(
			workspacePath,
			"zeta",
			"name: demo\ndescription: second description",
			"# Zeta body\n",
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const env = await workspaceEnv(workspacePath);
			const skills = sectionByKey(SKILLS_SECTION_KEY);
			const text = await skills.render(promptInput(env), BACKGROUND_CONTEXT);
			expect(text).toContain("- demo: first description");
			expect(text).not.toContain("second description");

			const tool = loadSkillTool();
			const { api, chunks } = toolApi(env);
			const result = await tool.execute({ name: "demo" }, api, BACKGROUND_CONTEXT);
			expect(result.isError).toBeUndefined();
			expect(chunks.join("")).toBe("# Alpha body\n");

			const logged = warn.mock.calls.map((call) => String(call[0]));
			expect(
				logged.some(
					(line) =>
						line.includes("demo") &&
					line.includes("alpha") &&
					line.includes("zeta"),
				),
			).toBe(true);
		} finally {
			warn.mockRestore();
		}
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("disable-model-invocation: true hides the skill from the section and load_skill", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-skills-"));
	try {
		await writeSkill(
			workspacePath,
			"hidden",
			"name: secret\ndescription: Must never reach the model.\ndisable-model-invocation: true",
		);
		await writeSkill(
			workspacePath,
			"visible",
			"name: deploy\ndescription: Run the deployment checklist.",
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const env = await workspaceEnv(workspacePath);
			const skills = sectionByKey(SKILLS_SECTION_KEY);
			const text = await skills.render(promptInput(env), BACKGROUND_CONTEXT);
			expect(text).toContain("- deploy:");
			expect(text).not.toContain("secret");
			expect(text).not.toContain("Must never reach the model.");

			// The hidden skill is unknown to load_skill — the explicit
			// unknown-skill error path, with the hidden name absent from the
			// available list.
			const tool = loadSkillTool();
			const { api } = toolApi(env);
			const result = await tool.execute(
				{ name: "secret" },
				api,
				BACKGROUND_CONTEXT,
			);
			expect(result.isError).toBe(true);
			const errorText = (result.output ?? [])
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("");
			expect(errorText).toContain("secret");
			expect(errorText).toContain("deploy");
			expect(errorText).not.toContain("hidden");

			const logged = warn.mock.calls.map((call) => String(call[0]));
			expect(logged.some((line) => line.includes("skills/hidden"))).toBe(true);
		} finally {
			warn.mockRestore();
		}
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("disable-model-invocation: false (or absent) keeps the skill listed and loadable", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-skills-"));
	try {
		// Explicit false — the common case must not regress.
		await writeSkill(
			workspacePath,
			"explicit-false",
			"name: deploy\ndescription: Run the deployment checklist.\ndisable-model-invocation: false",
			"# Explicit body\n",
		);
		const env = await workspaceEnv(workspacePath);
		const skills = sectionByKey(SKILLS_SECTION_KEY);
		const text = await skills.render(promptInput(env), BACKGROUND_CONTEXT);
		expect(text).toContain("- deploy: Run the deployment checklist.");

		const tool = loadSkillTool();
		const { api, chunks } = toolApi(env);
		const result = await tool.execute({ name: "deploy" }, api, BACKGROUND_CONTEXT);
		expect(result.isError).toBeUndefined();
		expect(chunks.join("")).toBe("# Explicit body\n");
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("non-SKILL.md files in a skill directory are ignored", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-skills-"));
	try {
		// Extra files beside a valid SKILL.md change nothing...
		const skillDir = join(workspacePath, "skills", "deploy");
		await mkdir(skillDir, { recursive: true });
		await writeFile(
			join(skillDir, "SKILL.md"),
			"---\nname: deploy\ndescription: Run the deployment checklist.\n---\n# Body\n",
		);
		await writeFile(join(skillDir, "NOTES.md"), "scratch notes");
		await writeFile(join(skillDir, "helper.txt"), "not a skill file");
		// ...and a directory with no SKILL.md at all is simply not a skill,
		// nor is a file sitting directly under skills/.
		const strayDir = join(workspacePath, "skills", "stray");
		await mkdir(strayDir, { recursive: true });
		await writeFile(join(strayDir, "README.md"), "no SKILL.md here");
		await writeFile(join(workspacePath, "skills", "notes.txt"), "not a dir");

		const env = await workspaceEnv(workspacePath);
		const skills = sectionByKey(SKILLS_SECTION_KEY);
		const text = await skills.render(promptInput(env), BACKGROUND_CONTEXT);
		expect(text).toContain("- deploy: Run the deployment checklist.");
		expect(text).not.toContain("stray");
		expect(text).not.toContain("scratch notes");
		expect(text).not.toContain("not a dir");

		const tool = loadSkillTool();
		const { api, chunks } = toolApi(env);
		const result = await tool.execute({ name: "deploy" }, api, BACKGROUND_CONTEXT);
		expect(result.isError).toBeUndefined();
		expect(chunks.join("")).toBe("# Body\n");
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("the section is capped at 4KB total with a truncation notice", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-skills-"));
	try {
		// 30 skills with ~300-byte lines: far past the 4KB cap.
		for (let i = 0; i < 30; i++) {
			await writeSkill(
				workspacePath,
				`skill-${String(i).padStart(2, "0")}`,
				`name: skill-${String(i).padStart(2, "0")}\ndescription: ${"d".repeat(280)}`,
			);
		}
		const skills = sectionByKey(SKILLS_SECTION_KEY);
		const text = await skills.render(
			promptInput(await workspaceEnv(workspacePath)),
			BACKGROUND_CONTEXT,
		);
		expect(text).toBeDefined();
		expect(byteLength(text ?? "")).toBeLessThanOrEqual(
			SKILLS_SECTION_LIMIT_BYTES,
		);
		// Early skills are listed, the overflow is not, and the notice says so.
		expect(text).toContain("- skill-00:");
		expect(text).not.toContain("skill-29:");
		expect(text).toContain("truncated");
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test("without an environment the section renders empty and the tool errors explicitly", async () => {
	const skills = sectionByKey(SKILLS_SECTION_KEY);
	expect(
		await skills.render(promptInput(undefined), BACKGROUND_CONTEXT),
	).toBeUndefined();

	const tool = loadSkillTool();
	const { api } = toolApi(undefined);
	const result = await tool.execute({ name: "any" }, api, BACKGROUND_CONTEXT);
	expect(result.isError).toBe(true);
});

test("a skills directory read failure fails loud", async () => {
	// Only `not_found` is the designed empty case; any other FileError is a
	// real failure and must throw, not silently render empty.
	const skills = sectionByKey(SKILLS_SECTION_KEY);
	const env = {
		cwd: "/",
		id: "test",
		listDir: () =>
			Promise.resolve({
				ok: false,
				error: {
					code: "permission_denied",
					message: "EACCES: permission denied",
				},
			}),
	} as unknown as ExecutionEnv;
	await expect(
		skills.render(promptInput(env), BACKGROUND_CONTEXT),
	).rejects.toThrow(/skills/);
	await expect(
		skills.render(promptInput(env), BACKGROUND_CONTEXT),
	).rejects.toThrow(/permission denied/);
});

test("openHarness installs the skills section and load_skill tool", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-harness-"));
	const workspacePath = join(dir, "workspace");
	try {
		await mkdir(workspacePath, { recursive: true });
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: workspacePath,
		});
		const opened = await openHarness(config, { env: {} });
		try {
			const snapshot = opened.registry.snapshot();
			expect(
				snapshot
					.sections()
					.some((entry) => entry.section.key === SKILLS_SECTION_KEY),
			).toBe(true);
			expect(
				snapshot.tools().some((entry) => entry.tool.name === "load_skill"),
			).toBe(true);
			// The installed extension still carries the core name (the
			// reserved-section owner is unchanged by the factory).
			expect(snapshot.extension(defaultExt.name)).toBeDefined();
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("harness generation includes the skills section from the workspace", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-harness-"));
	const workspacePath = join(dir, "workspace");
	try {
		await mkdir(workspacePath, { recursive: true });
		await writeSkill(
			workspacePath,
			"deploy",
			"name: deploy\ndescription: Run the deployment checklist end to end.",
		);
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: workspacePath,
		});
		// Scrubbed env keeps the test hermetic (T4 pattern): sections render
		// in `prepare` before the unconfigured provider call fails fast.
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
			const sections = (system as { sections?: Record<string, string> })
				.sections;
			expect(sections?.skills).toContain("- deploy: Run the deployment checklist");
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Core hardening W5 Task 4 (spec §9.4): the user dir, package skills, and
// the precedence order workspace > user > packages.
// ---------------------------------------------------------------------------

/** Write one SKILL.md fixture under an arbitrary ROOT (user/package shape). */
async function writeRootSkill(
	root: string,
	dir: string,
	name: string,
	description: string,
	body: string,
) {
	const skillDir = join(root, dir);
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
	);
}

test("skills under the user dir are listed and loadable", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-skills-user-"));
	const workspacePath = join(dir, "workspace");
	const userDir = join(dir, "user-skills");
	try {
		await mkdir(workspacePath, { recursive: true });
		await writeRootSkill(
			userDir,
			"housekeeping",
			"housekeeping",
			"User-wide deployment skill.",
			"# User body\n",
		);
		const ext = makeSkills({ userDir });
		const env = await workspaceEnv(workspacePath);
		const text = await sectionByKey(SKILLS_SECTION_KEY, ext).render(
			promptInput(env),
			BACKGROUND_CONTEXT,
		);
		expect(text).toContain("- housekeeping: User-wide deployment skill.");
		// The entry carries the SKILL.md's real path so the model can also
		// read it directly.
		expect(text).toContain(join(userDir, "housekeeping"));

		const { api, chunks } = toolApi(env);
		const result = await loadSkillTool(ext).execute(
			{ name: "housekeeping" },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(result.isError).toBeUndefined();
		expect(chunks.join("")).toBe("# User body\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an absent user dir is the designed empty case (no section, no error)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-skills-user-"));
	const workspacePath = join(dir, "workspace");
	try {
		await mkdir(workspacePath, { recursive: true });
		const ext = makeSkills({ userDir: join(dir, "no-such-user-skills") });
		expect(
			await sectionByKey(SKILLS_SECTION_KEY, ext).render(
				promptInput(await workspaceEnv(workspacePath)),
				BACKGROUND_CONTEXT,
			),
		).toBeUndefined();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("package-shipped skills are listed and loadable, in install order", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-skills-pkg-"));
	const workspacePath = join(dir, "workspace");
	const pkgA = join(dir, "pkg-a", "skills");
	const pkgB = join(dir, "pkg-b", "skills");
	try {
		await mkdir(workspacePath, { recursive: true });
		await writeRootSkill(
			pkgA,
			"linter",
			"linter",
			"Package A's linter skill.",
			"# A body\n",
		);
		await writeRootSkill(
			pkgB,
			"deployer",
			"deployer",
			"Package B's deployer skill.",
			"# B body\n",
		);
		const ext = makeSkills({
			packageRoots: () => [
				{ extension: "fixture-pkg-a", dir: pkgA },
				{ extension: "fixture-pkg-b", dir: pkgB },
			],
		});
		const env = await workspaceEnv(workspacePath);
		const text = await sectionByKey(SKILLS_SECTION_KEY, ext).render(
			promptInput(env),
			BACKGROUND_CONTEXT,
		);
		expect(text).toContain("- linter: Package A's linter skill.");
		expect(text).toContain("- deployer: Package B's deployer skill.");

		const { api, chunks } = toolApi(env);
		const result = await loadSkillTool(ext).execute(
			{ name: "deployer" },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(result.isError).toBeUndefined();
		expect(chunks.join("")).toBe("# B body\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("precedence: workspace > user > packages; the losing roots log the shadowing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-skills-prec-"));
	const workspacePath = join(dir, "workspace");
	const userDir = join(dir, "user-skills");
	const pkgDir = join(dir, "pkg", "skills");
	try {
		await mkdir(workspacePath, { recursive: true });
		await writeSkill(
			workspacePath,
			"deploy",
			"name: shared\ndescription: The workspace copy.",
			"# Workspace body\n",
		);
		await writeRootSkill(
			userDir,
			"deploy",
			"shared",
			"The user copy.",
			"# User body\n",
		);
		await writeRootSkill(
			pkgDir,
			"deploy",
			"shared",
			"The package copy.",
			"# Package body\n",
		);
		const ext = makeSkills({
			userDir,
			packageRoots: () => [{ extension: "fixture-pkg", dir: pkgDir }],
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const env = await workspaceEnv(workspacePath);
			const text = await sectionByKey(SKILLS_SECTION_KEY, ext).render(
				promptInput(env),
				BACKGROUND_CONTEXT,
			);
			expect(text).toContain("- shared: The workspace copy.");
			expect(text).not.toContain("The user copy.");
			expect(text).not.toContain("The package copy.");

			const { api, chunks } = toolApi(env);
			const result = await loadSkillTool(ext).execute(
				{ name: "shared" },
				api,
				BACKGROUND_CONTEXT,
			);
			expect(result.isError).toBeUndefined();
			expect(chunks.join("")).toBe("# Workspace body\n");

			// Both lower roots are named in the collision logs.
			const logged = warn.mock.calls.map((call) => String(call[0]));
			expect(
				logged.some(
					(line) =>
						line.includes("skills:") &&
						line.includes('"shared"') &&
						line.includes("shadowed"),
				),
			).toBe(true);
		} finally {
			warn.mockRestore();
		}

		// Removing the workspace copy hands the name to the user root —
		// discovery is per render, so no rebuild is needed.
		await rm(join(workspacePath, "skills", "deploy"), {
			recursive: true,
			force: true,
		});
		const env = await workspaceEnv(workspacePath);
		const text = await sectionByKey(SKILLS_SECTION_KEY, ext).render(
			promptInput(env),
			BACKGROUND_CONTEXT,
		);
		expect(text).toContain("- shared: The user copy.");
		const { api, chunks } = toolApi(env);
		const result = await loadSkillTool(ext).execute(
			{ name: "shared" },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(result.isError).toBeUndefined();
		expect(chunks.join("")).toBe("# User body\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("skills.sectionMaxBytes is read live per render", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-skills-cap-"));
	const workspacePath = join(dir, "workspace");
	try {
		await mkdir(workspacePath, { recursive: true });
		for (let i = 0; i < 8; i++) {
			await writeSkill(
				workspacePath,
				`skill-${String(i).padStart(2, "0")}`,
				`name: skill-${String(i).padStart(2, "0")}\ndescription: ${"d".repeat(60)}`,
			);
		}
		// The cap is a GETTER: flipping the value between renders takes
		// effect with no rebuild (boot wires settingsStore.read()).
		let cap = SKILLS_SECTION_LIMIT_BYTES;
		const ext = makeSkills({ sectionMaxBytes: () => cap });
		const env = await workspaceEnv(workspacePath);
		const render = () =>
			sectionByKey(SKILLS_SECTION_KEY, ext).render(
				promptInput(env),
				BACKGROUND_CONTEXT,
			);
		expect((await render()) ?? "").toContain("skill-07:");
		cap = 200;
		const truncated = await render();
		expect(truncated).toContain("truncated");
		expect(truncated).not.toContain("skill-07:");
		expect(byteLength(truncated ?? "")).toBeLessThanOrEqual(200);
		cap = SKILLS_SECTION_LIMIT_BYTES;
		expect((await render()) ?? "").toContain("skill-07:");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the truncation notice may shrink the section to the notice alone", async () => {
	// A cap smaller than the header + one line drops every line; when even
	// the header cannot fit, the NOTICE alone renders — the model still
	// learns skills exist and how many were cut.
	const dir = await mkdtemp(join(tmpdir(), "sigrun-skills-cap0-"));
	const workspacePath = join(dir, "workspace");
	try {
		await mkdir(workspacePath, { recursive: true });
		await writeSkill(
			workspacePath,
			"one",
			"name: one\ndescription: first skill",
		);
		const ext = makeSkills({ sectionMaxBytes: () => 60 });
		const text = await sectionByKey(SKILLS_SECTION_KEY, ext).render(
			promptInput(await workspaceEnv(workspacePath)),
			BACKGROUND_CONTEXT,
		);
		expect(text).not.toContain("- one:");
		expect(text).toContain("truncated");
		expect(text).toContain("load_skill");
		expect(byteLength(text ?? "")).toBeLessThanOrEqual(200);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
