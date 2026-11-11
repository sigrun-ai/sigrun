import type { EmbeddingResult } from "../../src/harness/embeddings.js";
import type { SigrunHost } from "../../../src/extension.js";

export declare const results: EmbeddingResult[];
export declare const pending: Promise<unknown>[];
export declare let capturedHost: SigrunHost | undefined;
export declare function resetEmbeddingCaller(): void;
export declare function callFromCaller(
	texts?: readonly string[],
	opts?: { model?: string; user?: string; confidentiality?: "normal" | "local-only"; signal?: AbortSignal; timeoutMs?: number },
): Promise<EmbeddingResult>;
declare function createFixtureEmbeddingCaller(host: SigrunHost): unknown;
export default createFixtureEmbeddingCaller;
