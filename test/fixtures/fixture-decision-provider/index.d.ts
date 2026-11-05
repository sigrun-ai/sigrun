import type { DecisionRequest } from "@sigrun/shared/decisions";

/** Every provider call, in order. */
export declare const calls: {
	request: DecisionRequest;
	model: string;
	credential: string | undefined;
	caller: string;
}[];

/** Make the provider slow (0 restores the instant answer). */
export declare function setProviderDelay(ms: number): void;

/** Clear the records (tests own their fixtures' state). */
export declare function resetDecisionProvider(): void;

declare function createFixtureDecisionProvider(): unknown;
export default createFixtureDecisionProvider;
