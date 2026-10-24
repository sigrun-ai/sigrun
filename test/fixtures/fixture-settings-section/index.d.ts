/** Type declarations for the settings-section fixture's test seams. */

/** Delivered `onSettingsChanged` key lists, in delivery order. */
export const received: string[][];

/** Clear the records (tests own their fixtures' state). */
export function reset(): void;

/** The section form the fixture declares (tests assert against it). */
export const SECTION_FORM: unknown;
