/**
 * The Blocks gallery (UI-blocks U1 Task 6): a dev-only page rendering
 * every U0 fixture sample through the real renderer, hosted by
 * `SurfaceView` over an in-memory `SurfaceTransport` that accepts every
 * action (moves/edit ops never touch a server; accepted actions simply
 * bump the rev so the optimistic overlay settles).
 *
 * A sample's tree + data come from `samples.ts`; the gallery routes by
 * hash: `#/blocks` lists the samples, `#/blocks/<name>` renders one.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
	JsonObject,
	SurfaceActResult,
	SurfaceLoad,
	SurfaceTransport,
	Tree,
} from "@sigrun/shared/blocks";
import { SurfaceView } from "../blocks/SurfaceView";
import { GALLERY_SAMPLES, type GallerySample } from "./samples";

/** An in-memory transport serving one sample; every action accepted. */
function galleryTransport(sample: GallerySample): SurfaceTransport {
	let rev = 1;
	const listeners = new Set<() => void>();
	return {
		load: async (): Promise<SurfaceLoad> => ({
			tree: sample.tree,
			data: sample.data,
			rev,
			treeRev: 1,
			access: "write",
		}),
		fetchData: async () => ({ rev, treeRev: 1 }),
		act: async (): Promise<SurfaceActResult> => {
			rev += 1;
			return { ok: true, rev };
		},
		upload: async (): Promise<SurfaceActResult> => {
			rev += 1;
			return { ok: true, rev };
		},
		image: async () => new Uint8Array(),
		onChanged: () => {
			return () => {
				listeners.clear();
			};
		},
	};
}

/** One sample page: the surface host rendering the fixture tree. */
function SampleView(props: { sample: GallerySample }): ReactNode {
	// One transport per sample identity (the tree/data are static).
	const transport = useMemo(
		() => galleryTransport(props.sample),
		[props.sample],
	);
	return (
		<div className="gallery-sample" data-gallery-sample={props.sample.name}>
			<h2>{props.sample.name}</h2>
			<SurfaceView transport={transport} />
		</div>
	);
}

/** The gallery shell: the sample list plus the selected sample. */
function sampleFromLocation(): string | null {
	return gallerySampleFromHash(
		(globalThis as { location?: { hash: string } }).location?.hash ?? "",
	);
}

export function GalleryView(): ReactNode {
	const [selected, setSelectedState] = useState<string | null>(() =>
		sampleFromLocation(),
	);
	// The hash is the route — refresh/back/forward follow it.
	useEffect(() => {
		const w = globalThis as {
			addEventListener?: (t: string, l: () => void) => void;
			removeEventListener?: (t: string, l: () => void) => void;
		};
		const onHash = (): void => setSelectedState(sampleFromLocation());
		w.addEventListener?.("hashchange", onHash);
		return () => w.removeEventListener?.("hashchange", onHash);
	}, []);
	const setSelected = (name: string): void => {
		setSelectedState(name);
		(
			globalThis as {
				history?: { pushState(a: null, b: string, c: string): void };
			}
		).history?.pushState(null, "", `#/blocks/${name}`);
	};
	const sample = GALLERY_SAMPLES.find((entry) => entry.name === selected);
	return (
		<div className="gallery" data-gallery="">
			<aside className="gallery-list">
				<h1>Blocks</h1>
				<ul>
					{GALLERY_SAMPLES.map((entry) => (
						<li key={entry.name}>
							<button
								type="button"
								data-gallery-entry={entry.name}
								onClick={() => setSelected(entry.name)}
							>
								{entry.name}
							</button>
						</li>
					))}
				</ul>
			</aside>
			<main className="gallery-main">
				{sample === undefined ? (
					<p className="gallery-hint">
						Pick a block sample — every entry renders through the real
						renderer over an in-memory surface.
					</p>
				) : (
					<SampleView sample={sample} />
				)}
			</main>
		</div>
	);
}

/** Parse `#/blocks/<name>` (the App wires hash routing). */
export function gallerySampleFromHash(hash: string): string | null {
	const match = /^#\/blocks\/(.+)$/.exec(hash);
	return match === null ? null : decodeURIComponent(match[1] ?? "");
}

/** Re-export the sample list for the e2e suite's enumeration. */
export { GALLERY_SAMPLES };
export type { Tree, JsonObject };
