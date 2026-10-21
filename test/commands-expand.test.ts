/**
 * Task 2c (server half): `/skill:name` and prompt-template EXPANSION —
 * the pure expansion primitives (`parseCommandArgs`, `substituteArgs`,
 * `expandTemplate`, `expandSkillCommand`) plus the `expandInput`
 * admission dispatch, in pi-1.3.0 parity:
 *
 * - `/skill:name [args]` expands to the exact `<skill …>` block (the
 *   blank line and `ARGS` only when arguments were given); an unknown
 *   skill passes through UNCHANGED (never an error);
 * - a `disable-model-invocation: true` skill is absent from the rendered
 *   section but still expands through `/skill:` (listSkills returns it
 *   with the flag; the section filters);
 * - arguments are shell-quoted (`/review "API compatibility"` is ONE
 *   argument); an unterminated quote is a usage error, not a swallow;
 * - every substitution form: `$1`…, `$@`/`$ARGUMENTS`, `${1:-default}`,
 *   `${@:-default}`, `${@:N}`, `${@:N:L}`;
 * - a `/name` that is a core or extension command keeps its meaning
 *   (expansion never claims it).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import {
	expandInput,
	expandSkillCommand,
	expandTemplate,
	parseCommandArgs,
	substituteArgs,
	type CommandExpansion,
} from "../src/commands/expand.js";
import { discoverTemplates } from "../src/commands/templates.js";
import {
	createWorkspaceService,
	defaultWorkspacePrefs,
} from "../src/harness/workspace.js";
import {
	SKILLS_SECTION_LIMIT_BYTES,
	listSkills,
	renderSkillList,
} from "../src/skills/index.js";

// ─── parseCommandArgs ──────────────────────────────────────────────────────

describe("parseCommandArgs", () => {
	test("whitespace-separated, quotes group, no escape processing", () => {
		expect(parseCommandArgs('a "b c" \'d\'')).toEqual(["a", "b c", "d"]);
	});

	test("a literal quote inside the other quote kind stays", () => {
		expect(parseCommandArgs(`"it's" 'say "hi"'`)).toEqual(["it's", 'say "hi"']);
	});

	test("a quoted empty string is one empty argument", () => {
		expect(parseCommandArgs('"" x')).toEqual(["", "x"]);
	});

	test("surrounding whitespace and repeated spaces produce no empty args", () => {
		expect(parseCommandArgs("   a    b  ")).toEqual(["a", "b"]);
		expect(parseCommandArgs("")).toEqual([]);
	});

	test("an unterminated quote is a usage error (fail loud)", () => {
		expect(() => parseCommandArgs('a "b c')).toThrow(/unterminated/);
		expect(() => parseCommandArgs("it's")).toThrow(/unterminated/);
	});
});

// ─── substituteArgs: every form from the table ────────────────────────────

describe("substituteArgs", () => {
	test("$1, $2, … positional", () => {
		expect(substituteArgs("$1 and $2", ["a", "b"])).toBe("a and b");
	});

	test("a missing positional substitutes empty", () => {
		expect(substituteArgs("$1/$2", ["a"])).toBe("a/");
		expect(substituteArgs("$ARGUMENTS", [])).toBe("");
	});

	test("$@ and $ARGUMENTS are all arguments, space-joined", () => {
		expect(substituteArgs("$@|$ARGUMENTS", ["a", "b c"])).toBe("a b c|a b c");
	});

	test("${1:-default} with and without the argument", () => {
		expect(substituteArgs("${1:-x}", [])).toBe("x");
		expect(substituteArgs("${1:-x}", ["y"])).toBe("y");
	});

	test("${@:-default} with and without arguments", () => {
		expect(substituteArgs("${@:-none}", [])).toBe("none");
		expect(substituteArgs("${@:-none}", ["a", "b"])).toBe("a b");
	});

	test("${@:N} slices from the Nth argument onwards", () => {
		expect(substituteArgs("${@:2}", ["a", "b", "c"])).toBe("b c");
		expect(substituteArgs("${@:9}", ["a"])).toBe("");
	});

	test("${@:N:L} takes L arguments starting at the Nth", () => {
		expect(substituteArgs("${@:2:1}", ["a", "b", "c"])).toBe("b");
		expect(substituteArgs("${@:1:2}", ["a", "b", "c"])).toBe("a b");
	});

	test("argument values are not recursively substituted", () => {
		expect(substituteArgs("$1", ["$2"])).toBe("$2");
	});
});

// ─── expandTemplate ────────────────────────────────────────────────────────

const REVIEW_TEMPLATE = {
	name: "review",
	description: "Review the changes",
	argsHint: "[focus]",
	content: "Review with focus: $1\nAll: $@",
	dir: "/templates",
};

describe("expandTemplate", () => {
	test("a matching name substitutes the parsed arguments", () => {
		expect(expandTemplate("/review concurrency", [REVIEW_TEMPLATE])).toBe(
			"Review with focus: concurrency\nAll: concurrency",
		);
	});

	test("quoted arguments group into one", () => {
		expect(
			expandTemplate('/review "API compatibility"', [REVIEW_TEMPLATE]),
		).toBe("Review with focus: API compatibility\nAll: API compatibility");
	});

	test("a non-matching name or non-command text passes through unchanged", () => {
		expect(expandTemplate("/nope x", [REVIEW_TEMPLATE])).toBe("/nope x");
		expect(expandTemplate("plain text", [REVIEW_TEMPLATE])).toBe("plain text");
	});

	test("no arguments with no placeholders substitutes to the body", () => {
		expect(expandTemplate("/review", [REVIEW_TEMPLATE])).toBe(
			"Review with focus: \nAll: ",
		);
	});
});

// ─── expandSkillCommand: the exact block shape ─────────────────────────────

const GREET_SKILL = {
	name: "greet",
	description: "Greet someone warmly.",
	body: "# Greeting\n\nSay hello to the user.\n",
	dir: "skills/greet",
	disableModelInvocation: false,
};

const GREET_BLOCK =
	'<skill name="greet" location="skills/greet/SKILL.md">\n' +
	"References are relative to skills/greet.\n" +
	"\n" +
	"# Greeting\n" +
	"\n" +
	"Say hello to the user.\n" +
	"</skill>"
describe("expandSkillCommand", () => {
	test("/skill:greet hej expands to the exact block plus args", () => {
		expect(expandSkillCommand("/skill:greet hej", [GREET_SKILL])).toBe(
			`${GREET_BLOCK}\n\nhej`,
		);
	});

	test("/skill:greet with no arguments has no trailing blank line", () => {
		expect(expandSkillCommand("/skill:greet", [GREET_SKILL])).toBe(GREET_BLOCK);
	});

	test("the arguments text is trimmed", () => {
		expect(expandSkillCommand("/skill:greet   hej  ", [GREET_SKILL])).toBe(
			`${GREET_BLOCK}\n\nhej`,
		);
	});

	test("an unknown skill passes through unchanged", () => {
		expect(expandSkillCommand("/skill:nope x", [GREET_SKILL])).toBe("/skill:nope x");
	});

	test("non-skill text passes through unchanged", () => {
		expect(expandSkillCommand("/review x", [GREET_SKILL])).toBe("/review x");
		expect(expandSkillCommand("hello", [GREET_SKILL])).toBe("hello");
	});
});

// ─── model-hidden skills: listed with the flag, filtered by the section ───

/** The conversation workspace env for a temp workspace (the skills-test shape). */
async function workspaceEnv(workspacePath: string) {
	return createWorkspaceService().forConversation(
		{ id: ROOT_CONVERSATION_ID },
		defaultWorkspacePrefs(workspacePath),
	);
}

test("a disable-model-invocation skill is hidden from the section but expands through /skill:", async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), "sigrun-expand-hidden-"));
	try {
		const hiddenDir = join(workspacePath, "skills", "hidden");
		await mkdir(hiddenDir, { recursive: true });
		await writeFile(
			join(hiddenDir, "SKILL.md"),
			"---\nname: secret\ndescription: Must never reach the model.\n" +
				"disable-model-invocation: true\n---\n# Secret body\n",
		);
		const opts = {
			userDir: join(tmpdir(), "sigrun-expand-hidden-user-absent"),
			packageRoots: (): readonly { extension: string; dir: string }[] => [],
			sectionMaxBytes: (): number => SKILLS_SECTION_LIMIT_BYTES,
		};
		const env = await workspaceEnv(workspacePath);
		const skills = await listSkills(env, BACKGROUND_CONTEXT, opts);
		const secret = skills.find((skill) => skill.name === "secret");
		expect(secret?.disableModelInvocation).toBe(true);
		// The section keeps filtering hidden skills out.
		const section = renderSkillList(skills, SKILLS_SECTION_LIMIT_BYTES);
		expect(section).toBeUndefined();
		// /skill: still expands it.
		expect(expandSkillCommand("/skill:secret now", skills)).toBe(
			'<skill name="secret" location="skills/hidden/SKILL.md">\n' +
				"References are relative to skills/hidden.\n" +
				"\n" +
				"# Secret body\n" +
				"</skill>\n" +
				"\n" +
				"now",
		);
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

// ─── expandInput: the admission dispatch ───────────────────────────────────

/** Inert expansion inputs over absent roots — only `commandNames` varies. */
function inertExpansion(commandNames: readonly string[] = []): CommandExpansion {
	const absentSkills = {
		userDir: join(tmpdir(), "sigrun-expand-skills-absent"),
		packageRoots: (): readonly { extension: string; dir: string }[] => [],
		sectionMaxBytes: (): number => 4096,
	};
	return {
		skills: absentSkills,
		templates: {
			userDir: join(tmpdir(), "sigrun-expand-prompts-absent"),
			packageRoots: (): readonly { extension: string; dir: string }[] => [],
		},
		commandNames: () => new Set(commandNames),
	};
}

describe("expandInput", () => {
	test("text not starting with / is untouched", async () => {
		const result = await expandInput(
			[{ type: "text", text: "hello there" }],
			inertExpansion(),
			undefined,
			BACKGROUND_CONTEXT,
		);
		expect(result.typed).toBeUndefined();
		expect(result.parts).toEqual([{ type: "text", text: "hello there" }]);
	});

	test("a /name that is a command keeps its meaning (no expansion)", async () => {
		const result = await expandInput(
			[{ type: "text", text: "/fork at 12" }],
			inertExpansion(["fork"]),
			undefined,
			BACKGROUND_CONTEXT,
		);
		expect(result.typed).toBeUndefined();
		expect(result.parts).toEqual([{ type: "text", text: "/fork at 12" }]);
	});

	test("an unknown /name with no matching template passes through", async () => {
		const result = await expandInput(
			[{ type: "text", text: "/nope x" }],
			inertExpansion(),
			undefined,
			BACKGROUND_CONTEXT,
		);
		expect(result.typed).toBeUndefined();
		expect(result.parts).toEqual([{ type: "text", text: "/nope x" }]);
	});

	test("a template from the user dir expands and records typed + command", async () => {
		const userDir = await mkdtemp(join(tmpdir(), "sigrun-expand-user-"));
		try {
			await mkdir(join(userDir, "prompts"), { recursive: true });
			await writeFile(
				join(userDir, "prompts", "review.md"),
				"---\ndescription: Review\n---\nReview with focus: $1\n",
			);
			const expansion: CommandExpansion = {
				...inertExpansion(),
				templates: {
					userDir: join(userDir, "prompts"),
					packageRoots: (): readonly { extension: string; dir: string }[] => [],
				},
			};
			const result = await expandInput(
				[{ type: "text", text: "/review concurrency" }],
				expansion,
				undefined,
				BACKGROUND_CONTEXT,
			);
			expect(result.typed).toBe("/review concurrency");
			expect(result.command).toBe("review");
			expect(result.parts).toEqual([
				{ type: "text", text: "Review with focus: concurrency" },
			]);
		} finally {
			await rm(userDir, { recursive: true, force: true });
		}
	});

	test("an unterminated quote surfaces as a usage error", async () => {
		const userDir = await mkdtemp(join(tmpdir(), "sigrun-expand-user-"));
		try {
			await mkdir(join(userDir, "prompts"), { recursive: true });
			await writeFile(
				join(userDir, "prompts", "review.md"),
				"---\ndescription: Review\n---\n$1\n",
			);
			const expansion: CommandExpansion = {
				...inertExpansion(),
				templates: {
					userDir: join(userDir, "prompts"),
					packageRoots: (): readonly { extension: string; dir: string }[] => [],
				},
			};
			await expect(
				expandInput(
					[{ type: "text", text: '/review "oops' }],
					expansion,
					undefined,
					BACKGROUND_CONTEXT,
				),
			).rejects.toThrow(/unterminated/);
		} finally {
			await rm(userDir, { recursive: true, force: true });
		}
	});

	test("only the leading text part is rewritten; other parts pass through in place", async () => {
		const userDir = await mkdtemp(join(tmpdir(), "sigrun-expand-user-"));
		try {
			await mkdir(join(userDir, "prompts"), { recursive: true });
			await writeFile(
				join(userDir, "prompts", "review.md"),
				"---\ndescription: Review\n---\nFocus: $1\n",
			);
			const expansion: CommandExpansion = {
				...inertExpansion(),
				templates: {
					userDir: join(userDir, "prompts"),
					packageRoots: (): readonly { extension: string; dir: string }[] => [],
				},
			};
			const parts = [
				{ type: "text", text: "/review api" },
				{ type: "image", path: "shot.png", mime: "image/png" },
			] as const;
			const result = await expandInput(
				parts,
				expansion,
				undefined,
				BACKGROUND_CONTEXT,
			);
			expect(result.parts).toEqual([
				{ type: "text", text: "Focus: api" },
				{ type: "image", path: "shot.png", mime: "image/png" },
			]);
		} finally {
			await rm(userDir, { recursive: true, force: true });
		}
	});

	test("a template colliding with a command name is skipped (never expands)", async () => {
		const userDir = await mkdtemp(join(tmpdir(), "sigrun-expand-user-"));
		try {
			await mkdir(join(userDir, "prompts"), { recursive: true });
			await writeFile(
				join(userDir, "prompts", "fork.md"),
				"---\ndescription: Not the fork\n---\nshould never expand\n",
			);
			const expansion: CommandExpansion = {
				...inertExpansion(["fork"]),
				templates: {
					userDir: join(userDir, "prompts"),
					packageRoots: (): readonly { extension: string; dir: string }[] => [],
				},
			};
			const templates = await discoverTemplates(
				undefined,
				BACKGROUND_CONTEXT,
				expansion.templates,
			);
			expect(templates.map((template) => template.name)).toEqual(["fork"]);
			const result = await expandInput(
				[{ type: "text", text: "/fork now" }],
				expansion,
				undefined,
				BACKGROUND_CONTEXT,
			);
			expect(result.typed).toBeUndefined();
			expect(result.parts).toEqual([{ type: "text", text: "/fork now" }]);
		} finally {
			await rm(userDir, { recursive: true, force: true });
		}
	});
});
