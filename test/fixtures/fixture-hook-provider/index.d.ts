import type { PublishedHookResult } from "../../../src/extension.js";

/** Every `recall.echo` run: `{caller, user, conversationId, payload}`. */
export declare const runs: {
	caller: string;
	user: string | undefined;
	conversationId: number | undefined;
	payload: unknown;
}[];

/** Clear the records (tests own their fixtures' state). */
export function resetHookProvider(): void;

declare function createFixtureHookProvider(): unknown;
export default createFixtureHookProvider;
export type { PublishedHookResult };
