/** Every provider call, in order. */
export declare const calls: { model: string; credential: string | undefined }[];

/** Clear the records and the readiness tracker. */
export declare function resetGatedEmbeddingProvider(): void;

declare function createFixtureGatedEmbeddingProvider(): unknown;
export default createFixtureGatedEmbeddingProvider;