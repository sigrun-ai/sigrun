/**
 * The embedding-provider result (the embedding-providers spec): a
 * TYPE-ONLY shared-leaf module with NO imports, so the extension
 * contract and the core registry name the same result shape.
 *
 * `embed` NEVER throws: failures use the coded `ok: false` half. Error
 * text never carries the credential or any submitted input text.
 */
export type EmbeddingResult =
	| {
			readonly ok: true;
			readonly model: string;
			readonly dimensions: number;
			readonly vectors: Float32Array[];
	  }
	| {
			readonly ok: false;
			readonly code:
				| "no_model"
				| "not_configured"
				| "not_local"
				| "timeout"
				| "failed"
				| "bad_response";
			readonly message: string;
	  };
