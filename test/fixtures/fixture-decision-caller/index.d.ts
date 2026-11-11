import type {
	DecisionRequest,
	DecisionResult,
} from "@sigrun/shared/decisions";
import type { SigrunHost } from "../../../src/extension.js";

/** Every settled evaluate result, in order. */
export declare const results: DecisionResult[];

/** In-flight calls fired during loading (the early-caller fixture). */
export declare const pending: Promise<unknown>[];

/** The captured host (the tests assert the slug identity through it). */
export declare let capturedHost: SigrunHost | undefined;

/** Clear the records (tests own their fixtures' state). */
export declare function resetDecisionCaller(): void;

/** Drive one evaluate through the stashed host; the result records. */
export declare function callFromCaller(
	request: DecisionRequest,
	opts?: { model?: string; user?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<DecisionResult>;

declare function createFixtureDecisionCaller(host: SigrunHost): unknown;
export default createFixtureDecisionCaller;
