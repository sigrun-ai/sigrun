/** Every run of THIS provider's `recall.echo`. */
export declare const altRuns: { caller: string; payload: unknown }[];

/** Clear the records (tests own their fixtures' state). */
export function resetHookProviderAlt(): void;

declare function createFixtureHookProviderAlt(): unknown;
export default createFixtureHookProviderAlt;
