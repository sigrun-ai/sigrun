/**
 * Task 2c (server half): prompt-template DISCOVERY across the three
 * roots — the workspace's `prompts/` (read through the conversation
 * `ExecutionEnv`), `<configDir>/prompts/`, and each installed package's
 * `prompts/` — first-wins in that order (the skills convention's
 * precedence), direct `.md` children only. Plus the catalog-facing
 * halves: `expandableTemplates` (a template whose name collides with a
 * core or extension command — or claims the reserved `skill:`
 * namespace — is skipped with ONE warning) and the `kind: "expand"`
 * catalog entries for templates and skills.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import {
	discoverTemplates,
	packagePromptRootsOf,
	type PromptTemplate,
} from "../src/commands/templates.js";
import { expandableTemplates } from "../src/commands/expand.js";
import { expandCommandEntries } from "../src/server/commands.js";
import {
	createWorkspaceService,
	defaultWorkspacePrefs,
} from "../src/harness/workspace.js";

/** The conversation workspace env for a temp workspace (the skills-test shape). */
async function workspaceEnv(workspacePath: string) {
	return createWorkspaceService().forConversation(
		{ id: ROOT_CONVERSATION_ID },
		defaultWorkspacePrefs(workspacePath),
	);
}

/** Write one template file under `root/prompts/`. */
async function writeTemplate(
	root: string,
	file: string,
	body: string,
	frontmatter = "",
) {
	await mkdir(join(root, "prompts"), { recursive: true });
	await writeFile(join(root, "prompts", file), `${frontmatter}${body}`);
}

/** Discovery options: a user dir + package roots over explicit dirs. */
function templateOptions(userDir: string, packages: { extension: string; dir: string }[]) {
	return {
		userDir,
		packageRoots: () => packages,
	};
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	warn.mockRestore();
});

/** The warned lines so far, as strings. */
function warnedLines(): string[] {
	return warn.mock.calls.map((call: unknown[]) =>
		typeof call[0] === "string" ? call[0] : String(call[0]),
	);
}

describe("discoverTemplates", () => {
	test("workspace beats user dir, user dir beats package; all three contribute", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "sigrun-tmpl-ws-"));
		const userDir = await mkdtemp(join(tmpdir(), "sigrun-tmpl-user-"));
		const packageRoot = await mkdtemp(join(tmpdir(), "sigrun-tmpl-pkg-"));
		try {
			await writeTemplate(workspace, "review.md", "WORKSPACE review $1\n");
			await writeTemplate(userDir, "review.md", "USER review\n");
			await writeTemplate(userDir, "deploy.md", "USER deploy\n");
			await writeTemplate(packageRoot, "audit.md", "PACKAGE audit\n");

			const templates = await discoverTemplates(
				await workspaceEnv(workspace),
				BACKGROUND_CONTEXT,
				templateOptions(join(userDir, "prompts"), [
					{ extension: "acme-ext", dir: join(packageRoot, "prompts") },
				]),
			);
			const byName = new Map(templates.map((t) => [t.name, t]));
			expect([...byName.keys()].sort()).toEqual(["audit", "deploy", "review"]);
			expect(byName.get("review")?.content).toBe("WORKSPACE review $1");
			expect(byName.get("deploy")?.content).toBe("USER deploy");
			expect(byName.get("audit")?.content).toBe("PACKAGE audit");
			expect(byName.get("audit")?.extension).toBe("acme-ext");
		} finally {
			await Promise.all([
				rm(workspace, { recursive: true, force: true }),
				rm(userDir, { recursive: true, force: true }),
				rm(packageRoot, { recursive: true, force: true }),
			]);
		}
	});

	test("a nested prompts/sub/x.md is ignored — direct .md children only", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "sigrun-tmpl-ws-"));
		try {
			await writeTemplate(workspace, "review.md", "top level\n");
			await mkdir(join(workspace, "prompts", "sub"), { recursive: true });
			await writeFile(join(workspace, "prompts", "sub", "x.md"), "nested\n");
			await writeFile(join(workspace, "prompts", "notes.txt"), "not a template");

			const templates = await discoverTemplates(
				await workspaceEnv(workspace),
				BACKGROUND_CONTEXT,
				templateOptions(join(tmpdir(), "sigrun-tmpl-absent"), []),
			);
			expect(templates.map((t) => t.name)).toEqual(["review"]);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	test("absent roots are the designed empty case", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "sigrun-tmpl-ws-"));
		try {
			const templates = await discoverTemplates(
				await workspaceEnv(workspace),
				BACKGROUND_CONTEXT,
				templateOptions(join(tmpdir(), "sigrun-tmpl-absent"), []),
			);
			expect(templates).toEqual([]);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	test("description comes from frontmatter, else the first non-empty line; argument-hint is optional", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "sigrun-tmpl-ws-"));
		try {
			await writeTemplate(
				workspace,
				"review.md",
				"Review the diff carefully.\nMore detail.\n",
				"---\ndescription: Review the changes\nargument-hint: \"[focus]\"\n---\n",
			);
			await writeTemplate(
				workspace,
				"deploy.md",
				"\n\nDeploy the current build.\nDetails.\n",
			);
			const templates = await discoverTemplates(
				await workspaceEnv(workspace),
				BACKGROUND_CONTEXT,
				templateOptions(join(tmpdir(), "sigrun-tmpl-absent"), []),
			);
			const byName = new Map(templates.map((t) => [t.name, t]));
			expect(byName.get("review")?.description).toBe("Review the changes");
			expect(byName.get("review")?.argsHint).toBe("[focus]");
			expect(byName.get("deploy")?.description).toBe("Deploy the current build.");
			expect(byName.get("deploy")?.argsHint).toBeUndefined();
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});

describe("expandableTemplates", () => {
	const template = (name: string): PromptTemplate => ({
		name,
		description: `The ${name} template`,
		content: `${name} body`,
		dir: "/templates",
	});

	test("a template named like a command is skipped with ONE warning", () => {
		const kept = expandableTemplates(
			[template("review"), template("fork")],
			new Set(["fork"]),
		);
		expect(kept.map((t) => t.name)).toEqual(["review"]);
		const lines = warnedLines();
		const forkWarnings = lines.filter((line) => line.includes('"fork"'));
		expect(forkWarnings).toHaveLength(1);
		expect(forkWarnings[0]).toContain("command");
	});

	test("a template claiming the skill: namespace is skipped with one warning", () => {
		const kept = expandableTemplates(
			[template("skill:greet"), template("review")],
			new Set([]),
		);
		expect(kept.map((t) => t.name)).toEqual(["review"]);
		const lines = warnedLines();
		expect(lines.some((line) => line.includes('"skill:greet"'))).toBe(true);
	});

	test("nothing colliding keeps everything, silently", () => {
		const kept = expandableTemplates(
			[template("review"), template("audit")],
			new Set(["fork"]),
		);
		expect(kept.map((t) => t.name)).toEqual(["review", "audit"]);
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("expandCommandEntries", () => {
	test("skills become skill:<name> entries; templates carry their argument-hint", () => {
		const entries = expandCommandEntries(
			[
				{
					name: "greet",
					description: "Greet someone warmly.",
					body: "body",
					dir: "skills/greet",
					disableModelInvocation: false,
				},
			],
			[
				{
					name: "review",
					description: "Review the changes",
					argsHint: "[focus]",
					content: "body",
					dir: "/templates",
				},
				{
					name: "audit",
					description: "Audit the tree",
					content: "body",
					dir: "/templates",
				},
			],
		);
		expect(entries).toEqual([
			{
				name: "skill:greet",
				description: "Greet someone warmly.",
				kind: "expand",
			},
			{
				name: "review",
				description: "Review the changes",
				argsHint: "[focus]",
				kind: "expand",
			},
			{
				name: "audit",
				description: "Audit the tree",
				kind: "expand",
			},
		]);
	});
});

describe("packagePromptRootsOf", () => {
	test("an installed package's prompts/ directory becomes an attributed root", async () => {
		const packageDir = await mkdtemp(join(tmpdir(), "sigrun-tmpl-pkgroot-"));
		try {
			await mkdir(join(packageDir, "dist"), { recursive: true });
			await mkdir(join(packageDir, "prompts"), { recursive: true });
			await writeFile(
				join(packageDir, "package.json"),
				'{"name":"@acme/ext","version":"0.1.0"}',
			);
			await writeFile(join(packageDir, "dist", "index.js"), "export {}");
			const roots = packagePromptRootsOf([
				`file://${join(packageDir, "dist", "index.js")}`,
			]);
			expect(roots).toEqual([
				{ extension: "@acme/ext", dir: join(packageDir, "prompts") },
			]);
		} finally {
			await rm(packageDir, { recursive: true, force: true });
		}
	});

	test("a package without prompts/ contributes nothing", async () => {
		const packageDir = await mkdtemp(join(tmpdir(), "sigrun-tmpl-pkgroot-"));
		try {
			await mkdir(join(packageDir, "dist"), { recursive: true });
			await writeFile(join(packageDir, "package.json"), '{"name":"acme"}');
			await writeFile(join(packageDir, "dist", "index.js"), "export {}");
			expect(
				packagePromptRootsOf([`file://${join(packageDir, "dist", "index.js")}`]),
			).toEqual([]);
			// Non-path specifiers (bare names) carry no location at all.
			expect(packagePromptRootsOf(["acme-ext"])).toEqual([]);
		} finally {
			await rm(packageDir, { recursive: true, force: true });
		}
	});
});
