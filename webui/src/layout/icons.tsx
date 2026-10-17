/**
 * icons (B2, UI refresh): the app's inline SVG icon set. No icon font, no
 * extra dependency (the webui dep contract) — every glyph is a stroke
 * path copied or traced from the refresh mockup
 * (docs/superpowers/specs/assets/2026-10-17-ui-refresh/web-main-view.html),
 * rendered at 24×24 viewBox and sized by CSS (`.rail-btn svg`, …).
 *
 * All icons share the same stroke conventions as the mockup (no fill,
 * `currentColor`, round caps/joins, weight 1.7) so one CSS rule colours
 * the whole set.
 */

import type { ReactNode } from "react";

export interface IconProps {
	readonly className?: string;
}

function Svg(props: IconProps & { readonly children: ReactNode }) {
	return (
		<svg
			className={props.className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.7}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{props.children}
		</svg>
	);
}

/** The rail's brand rune (the mockup's ᛋ mark, drawn as a path). */
export function BrandMark(props: IconProps) {
	return (
		<svg
			className={props.className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.9}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{/* ᛋ (sowilo): two diagonal strokes meeting a vertical — the brand. */}
			<path d="M8 20 16 4" />
			<path d="M6 5.5 11 12l-5 6.5" />
			<path d="M18 5.5 13 12l5 6.5" />
		</svg>
	);
}

/** Chats (the rail's only section entry — a speech bubble). */
export function ChatsIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
		</Svg>
	);
}

/** Settings (a gear). */
export function SettingsIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
		</Svg>
	);
}

/** The narrow-viewport drawer toggle (a hamburger). */
export function MenuIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M4 6h16M4 12h16M4 18h16" />
		</Svg>
	);
}

/** Outline panel toggle (the mockup's list-lines glyph). */
export function OutlineIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
		</Svg>
	);
}

/** Workspace panel toggle (the mockup's split-pane glyph). */
export function WorkspaceIcon(props: IconProps) {
	return (
		<Svg {...props}>
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<path d="M15 4v16" />
		</Svg>
	);
}

/** The ⋯ more-actions menu (three dots, filled). */
export function MoreIcon(props: IconProps) {
	return (
		<svg
			className={props.className}
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
		>
			<circle cx="5" cy="12" r="1.6" />
			<circle cx="12" cy="12" r="1.6" />
			<circle cx="19" cy="12" r="1.6" />
		</svg>
	);
}
