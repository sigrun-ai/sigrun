/** Every judge `evaluate` call: the raw request the warden sent. */
export declare const calls: { request: unknown }[];

/** The judge answers, consumed in order; the last one repeats. */
export declare const responses: unknown[];

/** Every `acme-media/torrents_remove` execution. */
export declare const toolRuns: { ids: number[] }[];

/** Reset every module-side record (tests own their fixtures' state). */
export function resetWardenE2e(): void;

declare function createFixtureWardenE2e(): unknown;
export default createFixtureWardenE2e;
