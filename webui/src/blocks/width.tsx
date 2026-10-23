/**
 * Width (UI-blocks U1 Task 1, spec §12): the container-width classes.
 * The `ContainerWidth` provider measures ITS OWN element with a
 * `ResizeObserver` (never the viewport) and publishes the class plus
 * the rem width: `compact` < 40 rem, `regular` 40–75, `wide` > 75.
 * Purely visual differences live in `blocks.css` `@container` queries;
 * structural fallbacks (§12.3 — columns stacking, grid columns) read
 * `useWidthRem`/`useWidthClass` here.
 */

import {
	createContext,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";

/** The container classes a block's placement falls into (spec §12.1). */
export type WidthClass = "compact" | "regular" | "wide";

/** The class boundaries in rem (spec §12.1: compact < 40, wide > 75). */
const REGULAR_MIN_REM = 40;
const WIDE_MIN_REM = 75;

/** 1 rem in px at the default browser setting (16); the measurement
 *  converts the ResizeObserver's px into the rem the width tokens
 *  (16/24/32 rem) are expressed against. */
const REM_PX = 16;

/** The published measurement (class + the rem width itself, which the
 *  `columns` stacking rule sums `minWidth` tokens against). */
export interface WidthInfo {
	readonly widthClass: WidthClass;
	/** The container's width in rem; `null` before the first measure. */
	readonly rem: number | null;
}

/** Map a rem width to its class (spec §12.1). */
export function widthClassOf(rem: number): WidthClass {
	if (rem < REGULAR_MIN_REM) return "compact";
	if (rem > WIDE_MIN_REM) return "wide";
	return "regular";
}

/** Before the first measurement the tree renders with the class CSS
 *  container queries would give an unstyled block: `regular`, rem
 *  unknown (`columns` treats unknown as regular/fit, never stacked). */
const DEFAULT_WIDTH: WidthInfo = { widthClass: "regular", rem: null };

/** Provide a fixed width class in tests (the container measures; the
 *  tests pin the class directly). */
export const WidthContext = createContext<WidthInfo>(DEFAULT_WIDTH);

/** Provide the container's width class to the subtree (measures its
 *  own wrapper div with a ResizeObserver; 1 rem = 16 px). Environments
 *  without a ResizeObserver (react-test-renderer, older embeddeds)
 *  keep the default — the structural fallbacks then key off the
 *  measured-or-assumed rem the same way. */
export function ContainerWidth(props: { children: ReactNode }): ReactNode {
	const ref = useRef<HTMLDivElement | null>(null);
	const [info, setInfo] = useState<WidthInfo>(DEFAULT_WIDTH);

	useEffect(() => {
		// A missing ResizeObserver (react-test-renderer hosts, embedded
		// environments) keeps the default — the class flows only from
		// observer callbacks, never from an assumption.
		const observerCtor = (
			globalThis as { ResizeObserver?: new (
				callback: (entries: readonly ResizeObserverEntry[]) => void,
			) => ResizeObserver;
			}
		).ResizeObserver;
		if (observerCtor === undefined) return;
		const observer = new observerCtor((entries) => {
			// The wrapper is the only observed target; its entry carries
			// the content width. A missing entry keeps the last value.
			for (const entry of entries) {
				const rem = entry.contentRect.width / REM_PX;
				setInfo({ widthClass: widthClassOf(rem), rem });
			}
		});
		const element = ref.current;
		if (element !== null) observer.observe(element);
		return () => {
			observer.disconnect();
		};
	}, []);

	return (
		<WidthContext.Provider value={info}>
			<div ref={ref} className="blk-width">
				{props.children}
			</div>
		</WidthContext.Provider>
	);
}

/** The current container's width info. */
export function useWidthInfo(): WidthInfo {
	return useContext(WidthContext);
}

/** The current container's width class. */
export function useWidthClass(): WidthClass {
	return useContext(WidthContext).widthClass;
}

/** The current container's width in rem (`null` before the first
 *  measure — callers treat unmeasured as regular). */
export function useWidthRem(): number | null {
	return useContext(WidthContext).rem;
}
