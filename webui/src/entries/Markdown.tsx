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

const components: Components = {
	a: ({ node: _node, ...link }) => (
		<a {...link} target="_blank" rel="noreferrer" />
	),
	pre: CodeBlock,
	table: FilterableTable,
};

/** Render markdown source in one of the two variant stacks. */
export function Markdown(props: { source: string; variant: "prose" | "bubble" }) {
	return (
		<div className={`md md-${props.variant}`}>
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
				{props.source}
			</ReactMarkdown>
		</div>
	);
}
