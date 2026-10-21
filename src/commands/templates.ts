/**
 * Prompt-template discovery (Task 2c, pi parity) — the `/name` commands
 * whose bodies are Markdown files. Mirrors the skills convention's
 * three-root precedence EXACTLY (src/skills/index.ts):
 *
 * 1. the WORKSPACE root — `prompts/` under the conversation workspace,
 *    read through the conversation `ExecutionEnv`, so discovery follows
 *    the resolved workspace;
 * 2. the USER root — `<configDir>/prompts/`, read from the host
 *    filesystem;
 * 3. PACKAGE roots — each installed package's `prompts/` directory
 *    (attributed to the extension), read from the host filesystem.
 *
 * A name appearing in several roots keeps the HIGHER root's template
 * (first-wins across roots in precedence order); within one root the
 * filenames are unique by construction. Direct `.md` children only — a
 * nested `prompts/sub/x.md` is ignored. Both lists are re-scanned LIVE
 * (per `/v1/commands` request and per expansion — the same
 * live-roots posture as the skills section), so no reload command.
 *
 * Template shape (pi parity): frontmatter `description` (else the first
 * non-empty line of the body) and optional `argument-hint`; the body is
 * everything after the frontmatter block. `expandTemplate` (src/commands/
 * expand.ts) substitutes `$1`/`$@`-family placeholders in it.
 */

import type { Context } from "@earendil-works/chord";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** The prompts directory name under each of the three roots. */
export const PROMPTS_DIRECTORY = "prompts";

const FRONTMATTER_DELIMITER = "---";

/** One discovered prompt template. */
export interface PromptTemplate {
	/** The command name (the filename without `.md`) — `/review` comes from `review.md`. */
	readonly name: string;
	/** Frontmatter `description`, else the first non-empty line of the body. */
	readonly description: string;
	/** Frontmatter `argument-hint`, when the file carries one. */
	readonly argsHint?: string;
	/** The template body (frontmatter stripped) — what substitution runs over. */
	readonly content: string;
	/** The prompts directory the template was found under (catalog/trace only). */
	readonly dir: string;
	/**
	 * The contributing package's extension slug, when the template came
	 * from a package root (the workspace and user roots carry none).
	 */
	readonly extension?: string;
}

/** The template-discovery roots, mirroring `SkillsOptions`. */
export interface TemplateOptions {
	/** The user-wide root: `<configDir>/prompts/` (absent = the designed empty case). */
	readonly userDir: string;
	/**
	 * Package prompt roots, in install order — `{extension, dir}` pairs
	 * (the extension slug + its `prompts/` directory). Read live.
	 */
	readonly packageRoots: () => readonly { extension: string; dir: string }[];
}

/** Parsed template file: the frontmatter fields plus the body. */
interface ParsedTemplateFile {
	readonly description?: string;
	readonly argsHint?: string;
	readonly content: string;
}

/**
 * Split a leading `---`-delimited frontmatter block off `text`. The
 * block must start at the very first line; the content is everything
 * after the closing delimiter (leading newlines stripped, trailing
 * whitespace kept — substitutions are byte-faithful to the file).
 * Returns the unstripped text as content when no block is present.
 */
function parseTemplateFile(text: string): ParsedTemplateFile {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
		return { content: text.trim() };
	}
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trim() === FRONTMATTER_DELIMITER) {
			close = i;
			break;
		}
	}
	if (close === -1) {
		// An unterminated block is not frontmatter — the whole file is
		// body (the skills parser treats the file as invalid instead;
		// templates have no required fields, so the honest read is body).
		return { content: text };
	}
	const fields: Record<string, string> = {};
	for (const line of lines.slice(1, close)) {
		const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (match === null) continue;
		const value = match[2].trim();
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'")))
		) {
			fields[match[1]] = value.slice(1, -1);
		} else {
			fields[match[1]] = value;
		}
	}
	return {
		description: fields.description === "" ? undefined : fields.description,
		argsHint:
			fields["argument-hint"] === "" || fields["argument-hint"] === undefined
				? undefined
				: fields["argument-hint"],
		// Pi parity: the substitution body is the frontmatter-stripped
		// file, TRIMMED — `/name args` expands to the body with no leading
		// or trailing blank lines.
		content: lines.slice(close + 1).join("\n").trim(),
	};
}

/** Build one template from a file's text; `undefined` when it is not `.md`. */
function templateFromFile(
	file: string,
	text: string,
	dir: string,
	extension?: string,
): PromptTemplate {
	const parsed = parseTemplateFile(text);
	let description = parsed.description;
	if (description === undefined || description === "") {
		const firstLine = parsed.content
			.split(/\r?\n/)
			.find((line) => line.trim() !== "");
		description = firstLine?.trim();
	}
	return {
		name: basename(file).replace(/\.md$/, ""),
		description: description ?? "",
		...(parsed.argsHint === undefined ? {} : { argsHint: parsed.argsHint }),
		content: parsed.content,
		dir,
		...(extension === undefined ? {} : { extension }),
	};
}

/** Name comparison (plain code-point order, locale-independent). */
function byTemplateName(a: PromptTemplate, b: PromptTemplate): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Read the direct `.md` children of one prompts directory through the
 * conversation `ExecutionEnv` (the workspace root). An absent directory
 * is the designed empty case; any other failure fails loud. Nested
 * directories and non-`.md` files are ignored.
 */
async function scanEnvRoot(
	env: ExecutionEnv,
	context: Context,
): Promise<PromptTemplate[]> {
	const listing = await env.listDir(PROMPTS_DIRECTORY, context);
	if (!listing.ok) {
		if (listing.error.code === "not_found") return [];
		throw new Error(
			`Failed to list the ${PROMPTS_DIRECTORY}/ directory: ${listing.error.message}`,
			{ cause: listing.error },
		);
	}
	const templates: PromptTemplate[] = [];
	for (const entry of [...listing.value].sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	)) {
		if (entry.kind !== "file" || !entry.name.endsWith(".md")) continue;
		const read = await env.readTextFile(
			join(PROMPTS_DIRECTORY, entry.name),
			context,
		);
		if (!read.ok) {
			if (read.error.code === "not_found") continue;
			throw new Error(
				`Failed to read ${PROMPTS_DIRECTORY}/${entry.name}: ${read.error.message}`,
				{ cause: read.error },
			);
		}
		templates.push(
			templateFromFile(
				`${PROMPTS_DIRECTORY}/${entry.name}`,
				read.value,
				PROMPTS_DIRECTORY,
			),
		);
	}
	return templates;
}

/**
 * Read the direct `.md` children of ONE host-filesystem prompts
 * directory (the user dir or a package's). Same rules as the workspace
 * root; absent roots are the designed empty case. Reads synchronously —
 * the root is host-local by definition (the skills module's posture).
 */
function scanFsRoot(root: string, extension?: string): PromptTemplate[] {
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
		throw new Error(
			`Failed to list the prompts root ${root}: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
			{ cause },
		);
	}
	const templates: PromptTemplate[] = [];
	for (const entry of [...entries].sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	)) {
		const file = join(root, entry.name);
		// A symlink to a file counts (pi parity); a broken one is skipped.
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				isFile = statSync(file).isFile();
			} catch {
				continue;
			}
		}
		if (!isFile || !entry.name.endsWith(".md")) continue;
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (cause) {
			throw new Error(
				`Failed to read ${file}: ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
				{ cause },
			);
		}
		templates.push(templateFromFile(file, text, root, extension));
	}
	return templates;
}

/**
 * Discover the templates across the three roots in precedence order
 * (workspace > user dir > packages, packages in install order),
 * first-wins on the NAME. A name lost to a higher root logs
 * `templates: "<name>" from <lower root> shadowed by <higher root>`
 * (the skills convention's shape).
 */
export async function discoverTemplates(
	env: ExecutionEnv | undefined,
	context: Context,
	opts: TemplateOptions,
): Promise<PromptTemplate[]> {
	const byName = new Map<string, PromptTemplate>();
	/**
	 * First-wins merge with a shadow log. `root` names the root the
	 * templates came from ("workspace", "user dir", "package");
	 * `extension` names the contributing package for package roots.
	 */
	const merge = (
		templates: readonly PromptTemplate[],
		root: string,
		extension?: string,
	): void => {
		for (const template of templates) {
			const existing = byName.get(template.name);
			if (existing !== undefined) {
				const existingRoot = existing.extension ?? "a higher root";
				console.warn(
					`templates: "${template.name}" from ${extension ?? root} shadowed by ${existingRoot}`,
				);
				continue;
			}
			byName.set(template.name, template);
		}
	};
	if (env !== undefined) {
		merge(await scanEnvRoot(env, context), "workspace");
	}
	merge(scanFsRoot(opts.userDir), "user dir");
	for (const root of opts.packageRoots()) {
		merge(scanFsRoot(root.dir, root.extension), "package", root.extension);
	}
	return [...byName.values()].sort(byTemplateName);
}

/**
 * The package prompt roots for one boot's loaded entries: each absolute
 * `file://` entry's package root (the nearest `package.json` at or above
 * the entry's directory) that SHIPS a `prompts/` directory, attributed
 * to the package's manifest name (falling back to the directory name).
 * Bare specifiers (no location) and packages without `prompts/`
 * contribute nothing. The loader's skill dirs stay skills-only; this
 * derivation exists because the loader has no fs coupling by contract
 * and the module dir is only resolvable from the entry URL.
 */
export function packagePromptRootsOf(
	entries: readonly string[],
): { extension: string; dir: string }[] {
	const roots: { extension: string; dir: string }[] = [];
	for (const entry of entries) {
		let entryPath: string | undefined;
		if (entry.startsWith("file://")) {
			try {
				entryPath = fileURLToPath(entry);
			} catch {
				continue;
			}
		} else if (entry.startsWith("/")) {
			entryPath = entry;
		} else {
			continue;
		}
		// The nearest package.json at or above the entry (the loader's
		// bounded-walk shape): the package root owning the entry.
		let current = dirname(entryPath);
		let packageRoot: string | undefined;
		for (let hops = 0; hops < 6; hops++) {
			if (existsSync(join(current, "package.json"))) {
				packageRoot = current;
				break;
			}
			const parent = dirname(current);
			if (parent === current) break;
			current = parent;
		}
		if (packageRoot === undefined) continue;
		const promptsDir = join(packageRoot, PROMPTS_DIRECTORY);
		if (!existsSync(promptsDir)) continue;
		let name: string | undefined;
		try {
			const parsed = JSON.parse(
				readFileSync(join(packageRoot, "package.json"), "utf8"),
			) as { name?: unknown };
			if (typeof parsed.name === "string" && parsed.name !== "") {
				name = parsed.name;
			}
		} catch {
			name = undefined;
		}
		roots.push({
			extension: name ?? basename(packageRoot),
			dir: promptsDir,
		});
	}
	return roots;
}
