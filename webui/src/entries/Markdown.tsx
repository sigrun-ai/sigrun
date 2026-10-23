/**
 * Markdown (B5, UI refresh): the ONE markdown renderer behind both
 * message kinds — react-markdown + remark-gfm with variant typography
 * (`prose` = the assistant's serif stack, `bubble` = the user's sans)
 * and the three custom behaviours the refresh adds:
 *
 * - GFM tables → {@link FilterableTable}: a filter bar once data rows
 *   pass {@link TABLE_FILTER_MIN_ROWS}; filtering is a case-insensitive
 *   substring over row text; the bar counts `<visible> of <total> rows`.
 * - Fenced code → a header (the fence language, or `text`) with a Copy
 *   button that writes the code text.
 * - Links open in a new tab with rel="noreferrer".
 *
 * UI-blocks U1 (spec §15) adds the explicit link allowlist: the shared
 * {@link safeUrlTransform} passes `https:`, `http:` and `mailto:`
 * through and returns `""` for every other scheme, and both the URL
 * transform and the link/image components apply it — a `tel:` or
 * `javascript:` link renders its text without the anchor. The block
 * renderer (webui/src/blocks) reuses this component, so block markdown
 * gets the same allowlist.
 *
 * Adapted from the refresh mockup's table/code chrome (hermes-webui's
 * look — see THIRD_PARTY_NOTICES, B7).
 */

import {
	Children,
	cloneElement,
	isValidElement,
	useEffect,
	useRef,
	useState,
	type ReactElement,
	type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { COPIED_RESET_MS, copyText } from "./MessageActions";

/** Data rows beyond this count earn the table's filter bar. */
export const TABLE_FILTER_MIN_ROWS = 6;

/** The schemes markdown links (and `open` actions) allow (spec §15). */
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set([
	"https",
	"http",
	"mailto",
]);

/**
 * The explicit URL transform (spec §15): `https:`, `http:` and
 * `mailto:` URLs pass through (whitespace/control characters stripped,
 * so a `" java\tscript:"` smuggling attempt cannot reach the DOM);
 * everything else — `tel:`, `javascript:`, `data:`, `irc:`, relative
 * and protocol-relative paths — returns `""`, which the link and image
 * components render as plain text / nothing.
 */
export function safeUrlTransform(url: string): string {
	// Browsers strip ASCII tab/newline/CR anywhere in a URL and trim
	// leading/trailing C0 controls and spaces before parsing the
	// scheme; do the same BEFORE matching so the allowlist sees what
	// the browser would resolve.
	const cleaned = url
		.replace(/[\t\n\r]/g, "")
		.replace(/[\u0000-\u0020]+$/, "")
		.replace(/^[\u0000-\u0020]+/, "");
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned)?.[1];
	if (scheme === undefined) return ""; // relative or protocol-relative
	return ALLOWED_SCHEMES.has(scheme.toLowerCase()) ? cleaned : "";
}

/** All text under a rendered element tree (the row filter's haystack). */
function elementText(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(elementText).join("");
	if (isValidElement(node)) {
		return elementText((node.props as { children?: ReactNode }).children);
	}
	return "";
}

/** A markdown table split into its body element and its data rows
 *  (GFM pipe tables render thead + tbody; without a tbody there is
 *  nothing to filter). `sections` is the caller's `Children.toArray`
 *  output — element identity must match what renders beside the clone. */
function tableBody(
	sections: readonly ReactNode[],
): {
	body: ReactElement<{ children?: ReactNode }> | null;
	rows: readonly ReactElement[];
} {
	for (const child of sections) {
		if (!isValidElement(child) || child.type !== "tbody") continue;
		const body = child as ReactElement<{ children?: ReactNode }>;
		return {
			body,
			rows: Children.toArray(body.props.children).filter(
				(node): node is ReactElement => isValidElement(node),
			),
		};
	}
	return { body: null, rows: [] };
}

/** The fence language of a code element ("language-ts" → "ts", else "text"). */
function languageOf(code: ReactElement<{ className?: string }>): string {
	return /language-([\w+-]+)/.exec(code.props.className ?? "")?.[1] ?? "text";
}

/** A GFM table with the optional filter bar (the count always reads
 *  `<visible> of <total> rows` once the bar is shown). */
function FilterableTable(props: { children?: ReactNode }) {
	const sections = Children.toArray(props.children);
	const { body, rows } = tableBody(sections);
	const [filter, setFilter] = useState("");
	const query = filter.trim().toLowerCase();
	const visible =
		query === ""
			? rows
			: rows.filter((row) => elementText(row).toLowerCase().includes(query));
	const filtering = query !== "" && body !== null;
	return (
		<div className="md-tbl">
			{rows.length > TABLE_FILTER_MIN_ROWS && (
				<div className="md-tbl-bar">
					<input
						type="text"
						aria-label="Filter rows"
						placeholder="Filter rows"
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
					/>
					<span className="md-tbl-count">
						{visible.length} of {rows.length} rows
					</span>
				</div>
			)}
			<table>
				{filtering ? sections.filter((child) => child !== body) : sections}
				{filtering && cloneElement(body, undefined, visible)}
			</table>
		</div>
	);
}

/** A fenced code block: language header + Copy over the mono body. */
function CodeBlock(props: { children?: ReactNode }) {
	const { children } = props;
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		return () => {
			if (timer.current !== null) clearTimeout(timer.current);
		};
	}, []);
	const nodes = Children.toArray(children);
	const code =
		nodes.length === 1 && isValidElement(nodes[0])
			? (nodes[0] as ReactElement<{ className?: string; children?: ReactNode }>)
			: null;
	if (code === null) return <pre>{children}</pre>;
	// A fence's code text carries the closing newline; Copy writes the code.
	const text = elementText(code.props.children).replace(/\n$/, "");
	const onCopy = (): void => {
		copyText(text);
		setCopied(true);
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
	};
	return (
		<div className="md-code">
			<div className="md-code-head">
				<span className="md-code-lang">{languageOf(code)}</span>
				<button
					type="button"
					className="md-code-copy"
					data-copied={copied || undefined}
					onClick={onCopy}
				>
					{copied ? "Copied" : "Copy"}
				</button>
			</div>
			<pre>
				<code>{text}</code>
			</pre>
		</div>
	);
}

/** A link the allowlist passed (new tab, no referrer). */
function SafeLink(props: {
	href?: string;
	children?: ReactNode;
}): ReactElement {
	const { href, children } = props;
	// `urlTransform` already ran; a disallowed scheme arrives as "" and
	// renders its text without the anchor (spec §15).
	if (href === undefined || href === "") return <span>{children}</span>;
	return (
		<a href={href} target="_blank" rel="noreferrer">
			{children}
		</a>
	);
}

/** An image the allowlist passed; a disallowed source renders nothing. */
function SafeImage(props: { src?: string; alt?: string }): ReactElement | null {
	const { src, alt } = props;
	if (src === undefined || src === "") return null;
	return <img src={src} alt={alt ?? ""} />;
}

const components: Components = {
	a: ({ node: _node, ...link }) => <SafeLink {...link} />,
	img: ({ node: _node, ...image }) => <SafeImage {...image} />,
	pre: CodeBlock,
	table: FilterableTable,
};

/** Render markdown source in one of the two variant stacks. */
export function Markdown(props: {
	source: string;
	variant: "prose" | "bubble";
}): ReactElement {
	return (
		<div className={`md md-${props.variant}`} dir="auto">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				urlTransform={safeUrlTransform}
				components={components}
			>
				{props.source}
			</ReactMarkdown>
		</div>
	);
}
