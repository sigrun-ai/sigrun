import type { PublishedHookResult, SigrunHost } from "../../../src/extension.js";

/** Every settled call result, in order. */
export const calls: PublishedHookResult[];

/** The in-flight call the factory fired during loading (if any). */
export const pending: Promise<unknown>[];

/** The captured host (the tests drive calls through it). */
export let capturedHost: SigrunHost | undefined;

/** Clear the records (tests own their fixtures' state). */
export function resetHookCaller(): void;

/** Fire a call through the stashed host; the settled result records. */
export function callFromCaller(
	name: string,
	payload: unknown,
	opts?: {
		user?: string;
		conversationId?: number;
		abortSignal?: AbortSignal;
	},
): Promise<PublishedHookResult>;

declare function createFixtureHookCaller(host: SigrunHost): unknown;
export default createFixtureHookCaller;

/** A caller variant that fires ONE call during loading (never awaited). */
export function createFixtureEarlyCaller(host: SigrunHost): unknown;
