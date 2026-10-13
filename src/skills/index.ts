/**
 * The skills convention (spec §3.2) — CORE-OWNED, not an extension package.
 *
 * Workspace skills are directories under `skills/` in the conversation
 * workspace, each carrying a `SKILL.md` with YAML-ish frontmatter
 * (agentskills.io shape). This module contributes two surfaces, bundled as
 * one pi-durable extension installed unconditionally in `openHarness`
 * alongside the context-file sections — core-owned means it never goes
 * through the extension loader and is never quarantined (spec §3).
 *
 * Both surfaces read the workspace through the conversation `ExecutionEnv`
 * — the section through `PromptInput.env`, the tool through
 * `ToolExecutionApi.env` — so discovery follows the resolved workspace
 * without this module knowing which.
 *
 * v1 semantics (spec §3.2, exact):
 *
 * - Discovery: `skills/<dir>/SKILL.md` only; other files ignored.
 * - Frontmatter `name` and `description` required (single-line values,
 *   matching quotes stripped); `disable-model-invocation: true` hides the
 *   skill from the model entirely — absent from the section, unknown to
 *   `load_skill` (pi's convention); all other fields ignored. A SKILL.md
 *   missing either required field — or the `---` block entirely — is
 *   skipped with a log.
 * - Duplicate names resolve first-wins (the earlier directory in sorted
 *   order) with a log.
 * - The section lists `- name: description (skills/<dir>)` per skill,
 *   capped at 4KB total with a truncation notice when capped; zero skills
 *   render no section.
 * - `load_skill(name)` returns the SKILL.md body (everything after the
 *   frontmatter block); an unknown name is an explicit error listing the
 *   available skills.
 */

import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	section,
} from "@earendil-works/pi-durable";
import type {
	PromptInput,
	ToolExecutionApi,
	ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv, FileInfo } from "@earendil-works/pi-durable/env";

/** The section key the skills list renders under. */
export const SKILLS_SECTION_KEY = "skills";

/** Total rendered-section budget (spec §3.2: 4KB, notice included). */
export const SKILLS_SECTION_LIMIT_BYTES = 4096;

const SKILLS_DIRECTORY = "skills";
const SKILL_FILE = "SKILL.md";
const FRONTMATTER_DELIMITER = "---";

const SKILLS_SECTION_HEADER =
	"Workspace skills. Call the load_skill tool with a skill's name to read its full instructions; each entry shows the skill's path, so you can also read its SKILL.md directly.";

/** One discovered workspace skill. */
export interface WorkspaceSkill {
	/** Frontmatter `name` — the skill's identity for the section and the tool. */
	readonly name: string;
	/** Frontmatter `description` — one line, listed in the section. */
	readonly description: string;
	/** The SKILL.md body: everything after the frontmatter block. */
	readonly body: string;
	/** The skill directory relative to the workspace root (`skills/<dir>`). */
	readonly dir: string;
	/** Frontmatter `disable-model-invocation: true` — hidden from the model. */
	readonly disableModelInvocation: boolean;
}

/** Parsed frontmatter: required fields absent when missing or empty. */
interface ParsedSkillFile {
	readonly name?: string;
	readonly description?: string;
	/** Frontmatter `disable-model-invocation: true` — the skill is hidden. */
	readonly disableModelInvocation: boolean;
	readonly body: string;
}

const encoder = new TextEncoder();

/** UTF-8 byte length — the unit the section cap is measured in. */
function byteLength(text: string): number {
	return encoder.encode(text).length;
}

/** Strip one matching pair of surrounding quotes, if present. */
function unquote(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1);
		}
	}
	return value;
}

/**
 * Parse a SKILL.md: the frontmatter must be a `---`-delimited block of
 * `key: value` lines at the very top; the body is everything after the
 * closing delimiter. Returns `undefined` when the block is absent or never
 * closes (neither required field could have parsed).
 */
function parseSkillFile(text: string): ParsedSkillFile | undefined {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) return undefined;
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trim() === FRONTMATTER_DELIMITER) {
			close = i;
			break;
		}
	}
	if (close === -1) return undefined;
	const fields: Record<string, string> = {};
	for (const line of lines.slice(1, close)) {
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (match === null) continue;
		const value = unquote(match[2].trim());
		if (value !== "") fields[match[1]] = value;
	}
	return {
		name: fields.name,
		description: fields.description,
		disableModelInvocation:
			fields["disable-model-invocation"] === "true",
		body: lines
			.slice(close + 1)
			.join("\n")
			.replace(/^\r?\n/, ""),
	};
}

/** Directory-name comparison (plain code-point order, locale-independent). */
function byDirectoryName(a: FileInfo, b: FileInfo): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Skill-name comparison (plain code-point order, locale-independent). */
function bySkillName(a: WorkspaceSkill, b: WorkspaceSkill): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Read and parse one skill directory's SKILL.md; `undefined` = not a skill. */
async function readSkill(
	env: ExecutionEnv,
	dir: FileInfo,
	context: Context,
): Promise<WorkspaceSkill | undefined> {
	const relative = `${SKILLS_DIRECTORY}/${dir.name}/${SKILL_FILE}`;
	const joined = await env.joinPath(
		[SKILLS_DIRECTORY, dir.name, SKILL_FILE],
		context,
	);
	if (!joined.ok) {
		throw new Error(`Failed to build path for ${relative}: ${joined.error.message}`, {
			cause: joined.error,
		});
	}
	const read = await env.readTextFile(joined.value, context);
	if (!read.ok) {
		if (read.error.code === "not_found") {
			// A directory without SKILL.md is simply not a skill (v1 ignores
			// every other file in a skill directory).
			return undefined;
		}
		throw new Error(`Failed to read ${relative}: ${read.error.message}`, {
			cause: read.error,
		});
	}
	const parsed = parseSkillFile(read.value);
	if (parsed === undefined) {
		console.warn(
			`skills: skipping ${relative} (the frontmatter block is required)`,
		);
		return undefined;
	}
	if (parsed.name === undefined) {
		console.warn(`skills: skipping ${relative} (the "name" field is required)`);
		return undefined;
	}
	if (parsed.description === undefined) {
		console.warn(
			`skills: skipping ${relative} (the "description" field is required)`,
		);
		return undefined;
	}
	return {
		name: parsed.name,
		description: parsed.description,
		body: parsed.body,
		dir: `${SKILLS_DIRECTORY}/${dir.name}`,
		disableModelInvocation: parsed.disableModelInvocation,
	};
}

/**
 * Scan the workspace's skills through the conversation `ExecutionEnv`.
 * An absent `skills/` directory is the designed empty case; any other read
 * failure fails loud. Directories are visited in sorted name order so
 * duplicate frontmatter names resolve deterministically first-wins. A
 * skill with `disable-model-invocation: true` doesn't exist as far as the
 * model is concerned: it never reaches the section or `load_skill`.
 */
export async function scanSkills(
	env: ExecutionEnv,
	context: Context,
): Promise<WorkspaceSkill[]> {
	const listing = await env.listDir(SKILLS_DIRECTORY, context);
	if (!listing.ok) {
		if (listing.error.code === "not_found") return [];
		throw new Error(
			`Failed to list the ${SKILLS_DIRECTORY}/ directory: ${listing.error.message}`,
			{ cause: listing.error },
		);
	}
	const directories = listing.value
		.filter((entry) => entry.kind === "directory")
		.sort(byDirectoryName);
	const byName = new Map<string, WorkspaceSkill>();
	for (const entry of directories) {
		const skill = await readSkill(env, entry, context);
		if (skill === undefined) continue;
		if (skill.disableModelInvocation) {
			console.warn(
				`skills: hiding ${skill.dir} (disable-model-invocation)`,
			);
			continue;
		}
		if (!byName.has(skill.name)) {
			byName.set(skill.name, skill);
		} else {
			const winner = byName.get(skill.name) as WorkspaceSkill;
			console.warn(
				`skills: duplicate name "${skill.name}" (${skill.dir} ignored; ${winner.dir} wins)`,
			);
		}
	}
	return [...byName.values()].sort(bySkillName);
}

/**
 * Assemble the section text: the header plus one `- name: description
 * (path)` line per skill, capped at {@link SKILLS_SECTION_LIMIT_BYTES}
 * bytes including the truncation notice. The path lets the model read the
 * SKILL.md directly (and resolve bundled references) via the read tool,
 * complementing `load_skill`. Whole lines drop from the end until the
 * text fits; the notice names how many skills were cut. Zero skills render
 * no section at all.
 */
export function renderSkillList(
	skills: readonly WorkspaceSkill[],
): string | undefined {
	if (skills.length === 0) return undefined;
	const header = `${SKILLS_SECTION_HEADER}\n\n`;
	const lines = skills.map(
		(skill) => `- ${skill.name}: ${skill.description} (${skill.dir})`,
	);
	const full = header + lines.join("\n");
	if (byteLength(full) <= SKILLS_SECTION_LIMIT_BYTES) return full;
	let kept = lines.length - 1;
	while (kept >= 0) {
		const dropped = lines.length - kept;
		const notice = `\n(skill list truncated: ${dropped} more not shown)`;
		const body = lines.slice(0, kept).join("\n");
		const text = header + body + notice;
		if (byteLength(text) <= SKILLS_SECTION_LIMIT_BYTES) return text;
		kept -= 1;
	}
	// The header alone always fits; reached only if a header change ever
	// grows past the budget.
	return header;
}

/** Section render: read the workspace via `PromptInput.env`, list the skills. */
async function renderSkills(
	input: PromptInput,
	context: Context,
): Promise<string | undefined> {
	if (input.env === undefined) return undefined;
	const skills = await scanSkills(input.env, context);
	return renderSkillList(skills);
}

/** An explicit tool error: text content the model can read and recover from. */
function skillError(message: string): ToolExecutionResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/** The `load_skill` tool: return one SKILL.md's body by name. */
export const loadSkillTool = defineTool({
	name: "load_skill",
	description:
		"Load one workspace skill's full instructions by name, as listed in the skills section.",
	parameters: Type.Object({
		name: Type.String({
			description: "The skill name exactly as listed in the skills section.",
		}),
	}),
	async execute(
		args: { name: string },
		api: ToolExecutionApi,
		context: Context,
	): Promise<ToolExecutionResult> {
		const env = api.env;
		if (env === undefined) {
			return skillError(
				"load_skill: this conversation has no workspace environment.",
			);
		}
		const skills = await scanSkills(env, context);
		const skill = skills.find((candidate) => candidate.name === args.name);
		if (skill === undefined) {
			if (skills.length === 0) {
				return skillError(
					`load_skill: unknown skill "${args.name}"; this workspace has no skills.`,
				);
			}
			const available = skills.map((candidate) => candidate.name).join(", ");
			return skillError(
				`load_skill: unknown skill "${args.name}"; available skills: ${available}`,
			);
		}
		api.output(skill.body);
		return {};
	},
});

/**
 * The skills extension (core-owned): one prompt section plus one tool.
 * `openHarness` installs it unconditionally before `Harness.open`.
 */
export const skillsExtension = defineExtension({
	name: "sigrun.skills",
	sections: [section(SKILLS_SECTION_KEY, renderSkills)],
	tools: [loadSkillTool],
});
