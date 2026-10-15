/**
 * Core-owned tool surface (plan Task 1): pi's coding tools plus the
 * hand-written search tools, installed by `openHarness` for every
 * conversation — never through the extension loader, never quarantined.
 *
 * TRUST POSTURE (spec): these tools are NOT filesystem-confined.
 * `isConfinedPath` (server/content-parts.ts) is an HTTP-submission-layer
 * check only; the model-driven tools may touch any path the conversation's
 * `ExecutionEnv` can reach. Sigrun's security model is policy-gated: an
 * installed gating extension (approvals/permissions, if the deploy adds
 * one) gates write/exec-class calls; with none installed, tool calls
 * proceed ungated (fail open — core ships no approvals of its own). No
 * filesystem confinement is claimed here.
 *
 * Two extensions install here:
 *
 * - `sigrun.coding-tools`: pi-durable's `write`, `edit`, `bash` factories
 *   plus a `read` wrapper that returns image files as image content
 *   (upstream's read hard-errors on images; sigrun's model surface accepts
 *   them — the same inline `ImageContent` the §5 submission path produces).
 * - `sigrun.search-tools`: `find`, `grep`, `ls` — hand-written in TypeScript
 *   against `ExecutionEnv` primitives (no shell-out to fd/rg), so remote
 *   workspaces stay correct regardless of the resolver (the env seam is the
 *   only filesystem access path; see workspace.ts).
 *
 * Everything resolves through `ToolExecutionApi.env` — the per-call env the
 * harness builds — so paths are conversation-relative exactly like the
 * upstream coding tools.
 */

import type { Context } from "@earendil-works/chord";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { ExecutionEnv, FileInfo } from "@earendil-works/pi-durable/env";

// ---------------------------------------------------------------------------
// Coding tools (read/write/edit/bash)
// ---------------------------------------------------------------------------

/**
 * The upstream text read this module wraps (see {@link imageReadTool}).
 * Built once; the wrapper delegates every execution to it.
 */
const textReadTool = createReadTool();

/** Extract the mime type from upstream's `unsupported_image` diagnostic. */
const IMAGE_MIME_IN_MESSAGE = /is an image \(([^)]+)\)/;

/**
 * The `read` tool with image support: delegates to pi-durable's read and
 * rescues exactly its `unsupported_image` error — the error carries the
 * byte-sniffed mime type, which the tools module does not export a detector
 * for — re-reading the bytes and returning them as base64 `ImageContent`
 * (the upload path's inline shape; pi-ai tool results admit image content).
 * Every other result — text content, truncation diagnostics, other errors —
 * passes through unchanged, and non-image binary behavior is upstream's.
 */
export const imageReadTool = defineTool({
	name: "read",
	description: `${textReadTool.description} Image files (PNG, JPEG, GIF, WebP, BMP) are returned as image content.`,
	parameters: textReadTool.parameters,
	async execute(args, api, context) {
		const result = await textReadTool.execute(args, api, context);
		if (result.isError !== true) return result;
		const diagnostic = result.diagnostics?.find(
			(candidate) => candidate.code === "unsupported_image",
		);
		const mimeType =
			diagnostic === undefined
				? undefined
				: IMAGE_MIME_IN_MESSAGE.exec(diagnostic.message)?.[1];
		if (mimeType === undefined || api.env === undefined) return result;
		// The sniffed bytes existed moments ago; resolve and re-read them.
		const resolved = await api.env.absolutePath(args.path, context);
		if (!resolved.ok) return result;
		const bytes = await api.env.readBinaryFile(resolved.value, context);
		if (!bytes.ok) return result;
		const image: ImageContent = {
			type: "image",
			data: Buffer.from(bytes.value).toString("base64"),
			mimeType,
		};
		return { output: [image] };
	},
});

/** `read`, `write`, `edit`, `bash` — core-installed for every conversation. */
export const codingToolsExtension = defineExtension({
	name: "sigrun.coding-tools",
	tools: [imageReadTool, createWriteTool(), createEditTool(), createBashTool()],
});

// ---------------------------------------------------------------------------
// Search tools (find/grep/ls) — pure TS over ExecutionEnv
// ---------------------------------------------------------------------------

/** Result cap shared by `find` and `grep`; past it the walk stops early. */
const MAX_RESULTS = 200;
/** Walk depth cap: a deep tree cannot recurse without bound. */
const MAX_WALK_DEPTH = 64;
/** Per-line truncation for grep hits, so one huge line cannot flood context. */
const GREP_LINE_LIMIT_CHARS = 300;
/** Never traversed, never listed — git's own rule for `.git`. */
const GIT_DIRECTORY = ".git";

/** An explicit tool error: text content the model can read and recover from. */
function searchError(message: string): ToolExecutionResult {
	return { output: [{ type: "text", text: message }], isError: true };
}

/**
 * `.gitignore` subset (documented, deliberately not a full engine):
 *
 * - one pattern per line; blank lines and `#` comments are skipped;
 *   trailing spaces are trimmed.
 * - `!` negation — the LAST matching rule wins (git semantics). A negated
 *   pattern cannot re-include anything under an already-ignored directory
 *   (the walk prunes ignored directories, matching git's documented rule).
 * - a trailing `/` makes the rule directory-only.
 * - a pattern containing a `/` (leading `/` stripped) is anchored: it
 *   matches the path from the ignore file's directory. Without one it
 *   matches at any depth (against any component-boundary suffix).
 * - globs: `*` = anything but `/`, `?` = one non-`/` char, `**` = anything
 *   including `/`; a `**` run followed by a slash also matches zero
 *   directories (git's `**` semantics). No character classes, no escapes.
 */
interface GitignoreRule {
	readonly negated: boolean;
	readonly dirOnly: boolean;
	readonly anchored: boolean;
	/** Full-match regex for one candidate path string. */
	readonly matcher: RegExp;
}

/**
 * Glob → anchored regex source (`*`, `?`, `**` per the subset above).
 * A `**` run followed by a slash becomes an optional any-directories
 * group — matching zero or more whole directories — so such patterns also
 * match files directly under their prefix; a bare `**` matches anything
 * including `/`.
 */
function globToRegExpSource(pattern: string): string {
	let source = "";
	let i = 0;
	while (i < pattern.length) {
		const char = pattern[i] as string;
		if (char === "*") {
			while (pattern[i + 1] === "*") i++;
			if (pattern[i + 1] === "/") {
				source += "(?:.*/)?";
				i++; // consume the slash (matched by the group)
			} else {
				source += ".*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
		}
		i++;
	}
	return source;
}

/** Parse `.gitignore` text into ordered rules (see the subset above). */
export function parseGitignore(text: string): readonly GitignoreRule[] {
	const rules: GitignoreRule[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		let line = rawLine.replace(/\s+$/, "");
		if (line === "" || line.startsWith("#")) continue;
		const negated = line.startsWith("!");
		if (negated) line = line.slice(1);
		const dirOnly = line.endsWith("/");
		if (dirOnly) line = line.slice(0, -1);
		if (line === "") continue;
		const anchored = line.includes("/");
		const pattern = line.startsWith("/") ? line.slice(1) : line;
		if (pattern === "") continue;
		rules.push({
			negated,
			dirOnly,
			anchored,
			matcher: new RegExp(`^${globToRegExpSource(pattern)}$`),
		});
	}
	return rules;
}

/**
 * Every component-boundary suffix of `path`, itself first:
 * `a/b/c` → `["a/b/c", "b/c", "c"]` — what an unanchored rule can match.
 */
function componentSuffixes(path: string): string[] {
	const suffixes: string[] = [];
	let candidate = path;
	for (;;) {
		suffixes.push(candidate);
		const slash = candidate.indexOf("/");
		if (slash === -1) return suffixes;
		candidate = candidate.slice(slash + 1);
	}
}

/** Whether one rule matches `relativePath` (`/`-joined, from the ignore file's dir). */
function ruleMatches(
	rule: GitignoreRule,
	relativePath: string,
	isDirectory: boolean,
): boolean {
	if (rule.dirOnly && !isDirectory) return false;
	const candidates = rule.anchored
		? [relativePath]
		: componentSuffixes(relativePath);
	return candidates.some((candidate) => rule.matcher.test(candidate));
}

/** Last-matching-rule verdict for one exact path (git's precedence). */
function lastMatchIgnored(
	rules: readonly GitignoreRule[],
	path: string,
	isDirectory: boolean,
): boolean {
	let ignored = false;
	for (const rule of rules) {
		if (ruleMatches(rule, path, isDirectory)) {
			ignored = !rule.negated;
		}
	}
	return ignored;
}

/**
 * Whether `relativePath` (`/`-joined, from the ignore file's dir) is
 * ignored: an ignored ANCESTOR DIRECTORY ignores everything below it — a
 * negated pattern cannot re-include files under an excluded directory
 * (git's documented rule) — otherwise the last matching rule for the path
 * itself wins.
 */
export function isIgnoredPath(
	rules: readonly GitignoreRule[],
	relativePath: string,
	isDirectory: boolean,
): boolean {
	const segments = relativePath.split("/");
	for (let end = 1; end < segments.length; end++) {
		const ancestor = segments.slice(0, end).join("/");
		if (lastMatchIgnored(rules, ancestor, true)) return true;
	}
	return lastMatchIgnored(rules, relativePath, isDirectory);
}

/** Read the walk root's `.gitignore`; absent file means no filtering. */
async function loadGitignore(
	env: ExecutionEnv,
	rootDir: string,
	context: Context,
): Promise<readonly GitignoreRule[]> {
	const read = await env.readTextFile(`${rootDir}/.gitignore`, context);
	if (read.ok) return parseGitignore(read.value);
	if (read.error.code === "not_found") return [];
	throw new Error(`Failed to read .gitignore: ${read.error.message}`, {
		cause: read.error,
	});
}

/** Strip `prefix + "/"` from an absolute path; `undefined` when not inside. */
function stripPathPrefix(path: string, prefix: string): string | undefined {
	if (path === prefix) return "";
	if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length + 1);
	return undefined;
}

/** One walked entry: `relative` is `/`-joined from the walk root. */
interface WalkEntry {
	readonly relative: string;
	readonly info: FileInfo;
}

/**
 * Depth-first walk of `rootDir` through `env.listDir`, in sorted name order.
 * Prunes `.git`, ignored directories, and directories past the depth cap;
 * skips ignored files; does not descend into symlinks. The visitor returns
 * (or resolves) `false` to stop the whole walk — how result caps end it.
 */
async function walkTree(
	env: ExecutionEnv,
	rootDir: string,
	rules: readonly GitignoreRule[],
	context: Context,
	visit: (entry: WalkEntry) => boolean | Promise<boolean>,
): Promise<void> {
	const stack: { dir: string; relative: string; depth: number }[] = [
		{ dir: rootDir, relative: "", depth: 0 },
	];
	while (stack.length > 0) {
		const frame = stack.pop() as {
			dir: string;
			relative: string;
			depth: number;
		};
		const listed = await env.listDir(frame.dir, context);
		if (!listed.ok) {
			if (listed.error.code === "not_found") continue;
			throw new Error(
				`Failed to list ${frame.dir}: ${listed.error.message}`,
				{ cause: listed.error },
			);
		}
		const entries = [...listed.value].sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
		const subdirs: { dir: string; relative: string; depth: number }[] = [];
		for (const info of entries) {
			if (info.name === GIT_DIRECTORY) continue;
			const relative =
				frame.relative === "" ? info.name : `${frame.relative}/${info.name}`;
			const isDirectory = info.kind === "directory";
			if (isIgnoredPath(rules, relative, isDirectory)) continue;
			if (!(await visit({ relative, info }))) return;
			if (isDirectory && frame.depth < MAX_WALK_DEPTH) {
				subdirs.push({ dir: info.path, relative, depth: frame.depth + 1 });
			}
		}
		// Stack pop-order is reversed; pushing reversed restores sorted order.
		for (const subdir of subdirs.reverse()) stack.push(subdir);
	}
}

/** The resolved search context shared by `find` and `grep`. */
interface SearchRoot {
	/** Absolute search-root directory. */
	readonly dir: string;
	readonly env: ExecutionEnv;
	readonly rules: readonly GitignoreRule[];
	/**
	 * Output-path prefix: the search root relative to the conversation cwd
	 * when it is inside it (rg-style cwd-relative output), else empty (paths
	 * relative to the search root).
	 */
	readonly prefix: string;
}

/**
 * Resolve the shared search preamble: env check, `path` resolution (default
 * `.`), directory check, and the `.gitignore` load. Returns an error text
 * on failure — a search over a bad path is a recoverable tool error.
 */
async function resolveSearchRoot(
	env: ExecutionEnv | undefined,
	path: string | undefined,
	context: Context,
): Promise<SearchRoot | { error: string }> {
	if (env === undefined) {
		return { error: "no workspace environment is configured" };
	}
	const resolved = await env.absolutePath(path ?? ".", context);
	if (!resolved.ok) {
		return {
			error: `could not resolve ${path ?? "."}: ${resolved.error.message}`,
		};
	}
	const info = await env.fileInfo(resolved.value, context);
	if (!info.ok) {
		return { error: `${path ?? "."}: ${info.error.message}` };
	}
	if (info.value.kind !== "directory") {
		return { error: `${path ?? "."} is not a directory` };
	}
	const rules = await loadGitignore(env, resolved.value, context);
	const prefix = stripPathPrefix(resolved.value, env.cwd) ?? "";
	return { dir: resolved.value, env, rules, prefix };
}

/** One output line for a walked entry, prefixed for the conversation cwd. */
function outputPath(root: SearchRoot, relative: string): string {
	return root.prefix === "" ? relative : `${root.prefix}/${relative}`;
}

/**
 * Whether a find pattern matches one result path (the cwd-relative path the
 * model sees): a pattern containing `/` matches the whole path; without one
 * it matches the name at any depth — the same convenience split as
 * unanchored gitignore rules.
 */
function globMatches(pattern: string, path: string): boolean {
	const matcher = new RegExp(`^${globToRegExpSource(pattern)}$`);
	return pattern.includes("/")
		? matcher.test(path)
		: componentSuffixes(path).some((suffix) => matcher.test(suffix));
}

/** The `find` tool: glob-match paths under a root, gitignore-filtered. */
export const findTool = defineTool({
	name: "find",
	description:
		"Find files and directories by glob pattern (*, ?, **). Without a / the pattern matches the name at any depth; with one it matches the path from the search root. Results honor .gitignore.",
	parameters: Type.Object({
		pattern: Type.String({
			description: "Glob pattern, e.g. *.ts or src/**/*.test.ts",
		}),
		path: Type.Optional(
			Type.String({
				description:
					"Directory to search in (relative or absolute); defaults to the working directory",
			}),
		),
	}),
	async execute(args, api, context) {
		const root = await resolveSearchRoot(api.env, args.path, context);
		if ("error" in root) return searchError(`find: ${root.error}.`);
		const matches: string[] = [];
		let capped = false;
		await walkTree(root.env, root.dir, root.rules, context, (entry) => {
			if (!globMatches(args.pattern, outputPath(root, entry.relative))) {
				return true;
			}
			if (matches.length >= MAX_RESULTS) {
				capped = true;
				return false;
			}
			matches.push(outputPath(root, entry.relative));
			return true;
		});
		const text =
			matches.length === 0 ? "No matches found." : matches.join("\n");
		return capped
			? {
					output: [
						{
							type: "text",
							text: `${text}\n…(capped at ${MAX_RESULTS} results)`,
						},
					],
					diagnostics: [
						{
							severity: "info",
							code: "truncated",
							message: `find: capped at ${MAX_RESULTS} results`,
						},
					],
				}
			: { output: [{ type: "text", text }] };
	},
});

/** Strict UTF-8 decode: `undefined` marks the binary files grep skips. */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The largest file grep will read whole into memory. Bigger files are
 * skipped like binary files (a whole-file regex read on a huge file is a
 * memory cliff; the chunked-read refactor is a follow-up).
 */
export const GREP_MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * The `grep` tool: regex over file contents, gitignore-filtered. Files over
 * `GREP_MAX_FILE_BYTES` are skipped with a note, same as binary files.
 */
export const grepTool = defineTool({
	name: "grep",
	description:
		"Search file contents with a regular expression (JavaScript syntax). Returns matching lines as path:line:text. Skips binary (non-UTF-8) files and files over 10 MB, and honors .gitignore.",
	parameters: Type.Object({
		pattern: Type.String({
			description: "Regular expression to search for, e.g. TODO|FIXME",
		}),
		path: Type.Optional(
			Type.String({
				description:
					"Directory to search in (relative or absolute); defaults to the working directory",
			}),
		),
	}),
	async execute(args, api, context) {
		let regex: RegExp;
		try {
			regex = new RegExp(args.pattern);
		} catch (error) {
			return searchError(
				`grep: invalid pattern ${JSON.stringify(args.pattern)}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		const root = await resolveSearchRoot(api.env, args.path, context);
		if ("error" in root) return searchError(`grep: ${root.error}.`);
		const matches: string[] = [];
		let binarySkipped = 0;
		let oversizedSkipped = 0;
		let capped = false;
		await walkTree(root.env, root.dir, root.rules, context, async (entry) => {
			if (entry.info.kind === "directory") return true;
			// Size cap before the whole-file read: over the cap, skip with a
			// note (same reporting slot as binary skips).
			if (entry.info.size > GREP_MAX_FILE_BYTES) {
				oversizedSkipped += 1;
				return true;
			}
			// Binary read + strict decode: non-UTF-8 files are skipped, not
			// searched as mojibake.
			const read = await root.env.readBinaryFile(entry.info.path, context);
			if (!read.ok) {
				if (read.error.code === "not_found") return true; // raced away
				throw new Error(
					`Failed to read ${entry.relative}: ${read.error.message}`,
					{ cause: read.error },
				);
			}
			let text: string;
			try {
				text = strictUtf8.decode(read.value);
			} catch {
				binarySkipped += 1;
				return true;
			}
			const lines = text.split(/\r?\n/);
			for (let index = 0; index < lines.length; index++) {
				const line = lines[index] as string;
				if (!regex.test(line)) continue;
				if (matches.length >= MAX_RESULTS) {
					capped = true;
					return false;
				}
				const shown =
					line.length > GREP_LINE_LIMIT_CHARS
						? `${line.slice(0, GREP_LINE_LIMIT_CHARS)}…`
						: line;
				matches.push(`${outputPath(root, entry.relative)}:${index + 1}:${shown}`);
			}
			return true;
		});
		const summary =
			matches.length === 0 ? "No matches found." : matches.join("\n");
		const note =
			`${binarySkipped > 0 ? ` (${binarySkipped} binary file(s) skipped)` : ""}` +
			`${oversizedSkipped > 0 ? ` (${oversizedSkipped} file(s) over ${GREP_MAX_FILE_BYTES / (1024 * 1024)} MB skipped)` : ""}` +
			`${capped ? ` (capped at ${MAX_RESULTS} matches)` : ""}`;
		return {
			output: [{ type: "text", text: note === "" ? summary : `${summary}${note}` }],
			...(capped
				? {
						diagnostics: [
							{
								severity: "info",
								code: "truncated",
								message: `grep: capped at ${MAX_RESULTS} matches`,
							},
						],
					}
				: {}),
		};
	},
});

/** The `ls` tool: one directory's entries, gitignore-filtered. */
export const lsTool = defineTool({
	name: "ls",
	description:
		"List one directory's entries (kind and name per line). Results honor .gitignore.",
	parameters: Type.Object({
		path: Type.Optional(
			Type.String({
				description:
					"Directory path to list (relative or absolute); defaults to the working directory",
			}),
		),
	}),
	async execute(args, api, context) {
		if (api.env === undefined) {
			return searchError("ls: no workspace environment is configured.");
		}
		const env = api.env;
		const resolved = await env.absolutePath(args.path ?? ".", context);
		if (!resolved.ok) {
			return searchError(
				`ls: could not resolve ${args.path ?? "."}: ${resolved.error.message}.`,
			);
		}
		const listed = await env.listDir(resolved.value, context);
		if (!listed.ok) {
			return searchError(
				`ls: ${args.path ?? "."}: ${listed.error.message}.`,
			);
		}
		const rules = await loadGitignore(env, resolved.value, context);
		const lines = [...listed.value]
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
			.filter(
				(info) =>
					info.name !== GIT_DIRECTORY &&
					!isIgnoredPath(rules, info.name, info.kind === "directory"),
			)
			.map((info) => `${info.kind}\t${info.name}`);
		return {
			output: [
				{
					type: "text",
					text: lines.length === 0 ? "(empty)" : lines.join("\n"),
				},
			],
		};
	},
});

/** `find`, `grep`, `ls` — core-installed for every conversation. */
export const searchToolsExtension = defineExtension({
	name: "sigrun.search-tools",
	tools: [findTool, grepTool, lsTool],
});
