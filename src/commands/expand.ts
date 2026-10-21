/**
 * Command EXPANSION at admission (Task 2c, pi parity): `/skill:name
 * [args]` and prompt-template `/name [args]` inputs are rewritten into
 * the text the model actually sees, server-side in `submitOp` BEFORE
 * content-part resolution — so the webui, the TUI,
 * `host.conversations.submit` and the HTTP API behave identically, and
 * job prompts can use templates too.
 *
 * Shapes (pi 1.3.0's, byte-for-byte):
 *
 * - `/skill:name args` → `<skill name="NAME" location="PATH">\nReferences
 *   are relative to DIR.\n\nBODY\n</skill>` plus `\n\nARGS` ONLY when
 *   arguments were given. An unknown skill passes through UNCHANGED
 *   (never an error — pi's behaviour). A `disable-model-invocation:
 *   true` skill is hidden from the prompt section but still expands
 *   here (`listSkills` returns it with the flag; the section filters).
 * - `/template args` → the template body with `$1`/`$@`-family
 *   placeholders substituted (see `substituteArgs`).
 *
 * A `/name` that is a core or extension command keeps its existing
 * meaning — expansion claims only `skill:*` and template names. At
 * admission the reserved-name check simply passes such inputs through
 * (the composer drives the endpoint); the CATALOG build additionally
 * skips a colliding template with one warning (R6), and a template
 * claiming the reserved `skill:` prefix is skipped the same way.
 *
 * The user entry carries what was typed: callers place the expanded
 * text as the admitted input with
 * `entry: {kind: "sigrun.user.expanded", data: {typed, command}}`, so
 * the transcript shows the typed text (pi-durable `InputEntry`; the
 * kind must not start with `pi.`).
 */

import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
	listSkills,
	type SkillsOptions,
	type WorkspaceSkill,
} from "../skills/index.js";
import {
	discoverTemplates,
	type PromptTemplate,
	type TemplateOptions,
} from "./templates.js";
import type { SubmissionPart } from "../server/content-parts.js";

/** The user entry kind an expanded input is placed as. */
export const EXPANDED_ENTRY_KIND = "sigrun.user.expanded";

/** What `expandInput` needs: the two root sets plus the reserved command names. */
export interface CommandExpansion {
	/** The skills-discovery roots (the same options the section renders with). */
	readonly skills: SkillsOptions;
	/** The template-discovery roots. */
	readonly templates: TemplateOptions;
	/**
	 * The FULL command-name set (core + extension commands), read live —
	 * a template colliding with any of these never expands.
	 */
	readonly commandNames: () => ReadonlySet<string>;
}

/** The outcome of one expansion pass. */
export interface ExpansionResult {
	/** The (possibly rewritten) wire parts. */
	readonly parts: readonly SubmissionPart[];
	/**
	 * The text the user typed, when an expansion rewrote the input — the
	 * `typed` field of the `sigrun.user.expanded` entry data.
	 */
	readonly typed?: string;
	/** The command that expanded (`skill:greet`, `review`), when one did. */
	readonly command?: string;
}

/**
 * Parse a command's raw argument text: whitespace-separated, single and
 * double quotes group, no escape processing beyond a literal quote
 * inside the other quote kind, no variable expansion, no globbing. An
 * UNTERMINATED quote is a usage error (fail loud — never a silent
 * swallow of half the input).
 */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	// Tracks whether a token has started, so quoted empty strings (""
	// or '') are kept as arguments.
	let hasToken = false;
	let inQuote: '"' | "'" | null = null;
	for (const char of argsString) {
		if (inQuote !== null) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			inQuote = char;
			hasToken = true;
		} else if (/\s/.test(char)) {
			if (hasToken) {
				args.push(current);
				current = "";
				hasToken = false;
			}
		} else {
			current += char;
			hasToken = true;
		}
	}
	if (inQuote !== null) {
		throw new Error(
			`unterminated quote in command arguments: ${argsString}`,
		);
	}
	if (hasToken) args.push(current);
	return args;
}

/**
 * Substitute argument placeholders in template content. Supported forms
 * (pi parity): `$1`, `$2`, …; `$@` and `$ARGUMENTS` (all arguments,
 * space-joined); `${N:-default}`; `${@:-default}`/`${ARGUMENTS:-default}`;
 * `${@:N}` (from the Nth argument onwards); `${@:N:L}` (L arguments
 * starting at the Nth). Replacement is single-pass: argument and
 * default values containing `$…` patterns are NOT recursively
 * substituted.
 */
export function substituteArgs(content: string, args: readonly string[]): string {
	const allArgs = args.join(" ");
	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(
			_match: string,
			defaultTarget: string | undefined,
			defaultValue: string | undefined,
			sliceStart: string | undefined,
			sliceLength: string | undefined,
			simple: string | undefined,
		): string => {
			if (defaultTarget !== undefined) {
				const value =
					defaultTarget === "@" || defaultTarget === "ARGUMENTS"
						? allArgs
						: args[Number.parseInt(defaultTarget, 10) - 1];
				return value ? value : (defaultValue ?? "");
			}
			if (sliceStart !== undefined) {
				// 1-indexed (bash convention: args start at 1); 0 is treated
				// as 1.
				let start = Number.parseInt(sliceStart, 10) - 1;
				if (start < 0) start = 0;
				if (sliceLength !== undefined) {
					const length = Number.parseInt(sliceLength, 10);
					return args.slice(start, start + length).join(" ");
				}
				return args.slice(start).join(" ");
			}
			if (simple === "ARGUMENTS" || simple === "@") return allArgs;
			return args[Number.parseInt(simple ?? "0", 10) - 1] ?? "";
		},
	);
}

/**
 * Expand `/name args` against the given templates: a matching name
 * parses the arguments (shell-quoted) and substitutes them into the
 * template body; anything else passes through UNCHANGED.
 */
export function expandTemplate(
	text: string,
	templates: readonly PromptTemplate[],
): string {
	if (!text.startsWith("/")) return text;
	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
	if (match === null) return text;
	const template = templates.find(
		(candidate) => candidate.name === match?.[1],
	);
	if (template === undefined) return text;
	return substituteArgs(template.content, parseCommandArgs(match[2] ?? ""));
}

/**
 * Expand `/skill:name [args]` against the given skills (pi's exact
 * shape): the `<skill …>` block, plus a blank line and the trimmed
 * arguments ONLY when arguments were given. An unknown skill — or any
 * other text — passes through UNCHANGED.
 */
export function expandSkillCommand(
	text: string,
	skills: readonly WorkspaceSkill[],
): string {
	if (!text.startsWith("/skill:")) return text;
	const spaceIndex = text.indexOf(" ");
	const skillName =
		spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
	const skill = skills.find((candidate) => candidate.name === skillName);
	if (skill === undefined) return text;
	const location = `${skill.dir}/SKILL.md`;
	// Pi parity: the body is the frontmatter-stripped SKILL.md, trimmed —
	// `</skill>` sits on its own line with no stray blank lines.
	const body = skill.body.trim();
	const block =
		`<skill name="${skill.name}" location="${location}">\n` +
		`References are relative to ${skill.dir}.\n` +
		`\n${body}\n` +
		`</skill>`;
	return args === "" ? block : `${block}\n\n${args}`;
}

/**
 * Drop templates whose names cannot be expansion commands: a name the
 * full command set already claims (core or extension — one warning per
 * template), and the reserved `skill:` namespace (the `/skill:` prefix
 * is the skills channel, never a template's).
 */
export function expandableTemplates(
	templates: readonly PromptTemplate[],
	commandNames: ReadonlySet<string>,
): PromptTemplate[] {
	const kept: PromptTemplate[] = [];
	for (const template of templates) {
		if (commandNames.has(template.name)) {
			console.warn(
				`templates: skipping "${template.name}" (${template.dir}) — ` +
					"the name is already a command; commands keep their meaning",
			);
			continue;
		}
		if (template.name.startsWith("skill:")) {
			console.warn(
				`templates: skipping "${template.name}" (${template.dir}) — ` +
					'the "skill:" prefix is reserved for /skill:name expansion',
			);
			continue;
		}
		kept.push(template);
	}
	return kept;
}

/**
 * Expand one input's leading text part, when it starts with `/` and
 * names a skill or an expandable template. Everything else — non-`/`
 * text, a `/name` that is a command, an unknown skill or template —
 * passes through untouched; the OTHER parts (attachments, further text
 * parts) pass through in place regardless.
 *
 * Returns the (possibly rewritten) parts plus `typed`/`command` for the
 * `sigrun.user.expanded` entry; `typed` absent means nothing expanded.
 * An unterminated quote in a template's arguments throws (the usage
 * error `parseCommandArgs` raises) — the submit path maps it to a
 * client error.
 */
export async function expandInput(
	parts: readonly SubmissionPart[],
	expansion: CommandExpansion,
	env: ExecutionEnv | undefined,
	context: Context,
): Promise<ExpansionResult> {
	// Only a LEADING text part starting with `/` is a command: the
	// command is what the user typed first (attachments and later text
	// parts pass through untouched, in place).
	const textPart = parts[0];
	if (
		textPart === undefined ||
		textPart.type !== "text" ||
		!textPart.text.startsWith("/")
	) {
		return { parts };
	}
	const text = textPart.text;
	// The command token: everything up to the first whitespace.
	const spaceIndex = text.search(/\s/);
	const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const reserved = expansion.commandNames();
	if (reserved.has(commandName)) return { parts };
	if (commandName.startsWith("skill:")) {
		const skills = await listSkills(env, context, expansion.skills);
		const expanded = expandSkillCommand(text, skills);
		if (expanded === text) return { parts };
		return {
			parts: parts.map((part) => (part === textPart ? { type: "text", text: expanded } : part)),
			typed: text,
			command: commandName,
		};
	}
	const templates = expandableTemplates(
		await discoverTemplates(env, context, expansion.templates),
		reserved,
	);
	const expanded = expandTemplate(text, templates);
	if (expanded === text) return { parts };
	return {
		parts: parts.map((part) => (part === textPart ? { type: "text", text: expanded } : part)),
		typed: text,
		command: commandName,
	};
}
