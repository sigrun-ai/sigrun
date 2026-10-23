/**
 * Type declarations for the fixture-surfaces test seam (the fixture is
 * plain JS — extensions load as js; this declares the seam's shape for
 * the routes test's imports).
 */

/** username → access level, for BOTH surfaces. */
export const accessOverrides: Map<string, string>;

/** Per-surface invocation counters. */
export const calls: {
	render: Record<string, number>;
	data: Record<string, number>;
};

/** One record per render/data invocation. */
export const contexts: {
	kind: string;
	id: string;
	user: string | undefined;
	params: unknown;
	key: string;
}[];

/** Reset the seam state. */
export function resetSurfaceFixture(): void;

export default function createFixtureSurfaces(): unknown;
