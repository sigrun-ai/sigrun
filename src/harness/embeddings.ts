/**
 * Embedding-providers Task 2: the pure embedding-provider registry.
 * Loader/boot wiring lands in later tasks; fixture declarations drive
 * this module directly.
 *
 * `embed` NEVER throws: failures use the contract's coded result. Error
 * text never carries the credential or any submitted input text. Unlike
 * decision providers, a missing credential does not itself block a call
 * (keyless local endpoints are valid); `not_configured` requires a missing
 * credential AND the provider's readiness reporting `not_configured`.
 */

import type {
	EmbeddingModelInfo,
	EmbeddingProviderContribution,
	ProviderReadiness,
} from "../extension.js";
import type { EmbeddingResult } from "@sigrun/shared/embeddings";
import type { EmbeddingDeclaration } from "./loader.js";
import type { Locality } from "./locality.js";

export type { EmbeddingResult } from "@sigrun/shared/embeddings";

export interface EmbeddingRegistry {
	embed(
		caller: string,
		texts: readonly string[],
		opts: {
			model?: string;
			confidentiality?: "normal" | "local-only";
			signal?: AbortSignal;
			timeoutMs?: number;
		},
	): Promise<EmbeddingResult>;
	/** `default` marks the row `embeddingModel` resolves to (at most one). */
	list(): readonly {
		model: string;
		provider: string;
		dimensions: number;
		local: boolean;
		default: boolean;
		status: ProviderReadiness["status"];
	}[];
	providers(): readonly {
		id: string;
		label?: string;
		extension: string;
		models: readonly string[];
		status: ProviderReadiness["status"];
	}[];
	collisions(): readonly { id: string; winner: string; losers: readonly string[] }[];
}

interface Entry {
	readonly declaration: EmbeddingDeclaration;
	readonly models: ReadonlyMap<string, EmbeddingModelInfo>;
}

function readiness(contribution: EmbeddingProviderContribution): ProviderReadiness["status"] {
	try {
		return contribution.readiness?.().status ?? "ready";
	} catch {
		return "degraded";
	}
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	try {
		return String(err);
	} catch {
		return "non-Error throw";
	}
}

/** Scrub every secret/text the provider could have copied into an error. */
function safeFailureMessage(
	err: unknown,
	credential: string | undefined,
	texts: readonly string[],
): string {
	let message = errorMessage(err);
	for (const sensitive of [credential, ...texts]) {
		if (sensitive) message = message.replaceAll(sensitive, "[redacted]");
	}
	return message;
}

/**
 * Build the embedding registry. Last-registered wins per provider id;
 * model resolution and the local-only gate run before credentials or a
 * provider call. Batches are sequential and concatenated in input order.
 */
export function buildEmbeddingRegistry(
	declarations: readonly EmbeddingDeclaration[],
	deps: {
		/** The live default and per-call timeout cap (locality is its own seam). */
		settings(): { embeddingModel?: string; timeoutCapMs: number };
		/** Settings split Plan 2 Task 2: locality is ONE switch per provider
		 * extension, applied per embed and per list row; the model's own
		 * `local: false` veto still wins. */
		locality: Locality;
		/** auth.json[id].apiKey, else the process env `credentialEnv` ("" = unset). */
		credential(providerId: string, credentialEnv?: string): Promise<string | undefined>;
		warn(message: string): void;
	},
): EmbeddingRegistry {
	const entries = new Map<string, Entry>();
	const collisionList: { id: string; winner: string; losers: string[] }[] = [];
	for (const declaration of declarations) {
		const id = declaration.contribution.id;
		const existing = entries.get(id);
		if (existing) {
			deps.warn(
				`embedding provider "${id}": ${declaration.extension} wins over ${existing.declaration.extension} (last-registered wins)`,
			);
			const recorded = collisionList.find((collision) => collision.id === id);
			if (recorded) {
				recorded.losers.push(recorded.winner);
				recorded.winner = declaration.extension;
			} else {
				collisionList.push({
					id,
					winner: declaration.extension,
					losers: [existing.declaration.extension],
				});
			}
		}
		entries.set(id, {
			declaration,
			models: new Map(declaration.contribution.models.map((model) => [model.id, model])),
		});
	}

	const localityOf = (resolved: { entry: Entry; model: EmbeddingModelInfo }): boolean =>
		deps.locality.isLocalExtension(resolved.entry.declaration.extension) &&
		resolved.model.local !== false;

	function resolveModel(spec: string | undefined): { entry: Entry; model: EmbeddingModelInfo; full: string } | undefined {
		if (spec === undefined) return undefined;
		const slash = spec.indexOf("/");
		if (slash < 0) return undefined;
		const providerId = spec.slice(0, slash);
		const modelId = spec.slice(slash + 1);
		const entry = entries.get(providerId);
		const model = entry?.models.get(modelId);
		if (!entry || !model) return undefined;
		return { entry, model, full: `${providerId}/${modelId}` };
	}

	async function embed(
		_caller: string,
		texts: readonly string[],
		opts: {
			model?: string;
			confidentiality?: "normal" | "local-only";
			signal?: AbortSignal;
			timeoutMs?: number;
		},
	): Promise<EmbeddingResult> {
		let settings: ReturnType<typeof deps.settings>;
		try {
			settings = deps.settings();
		} catch {
			return { ok: false, code: "failed", message: "could not read embedding settings" };
		}

		// 1. Model resolution is deliberately first: there is no silent default.
		const spec = opts.model ?? settings.embeddingModel;
		const resolved = resolveModel(spec);
		if (!resolved) {
			return {
				ok: false,
				code: "no_model",
				message: spec === undefined ? "no embedding model is configured" : `unknown embedding model "${spec}"`,
			};
		}

		// 2. Confidentiality fails closed before credentials or provider calls.
		// The gate also precedes the empty-input success: no confidential call
		//    succeeds against a non-local model, even with no texts to send.
		const local = localityOf(resolved);
		if (opts.confidentiality === "local-only" && !local) {
			return {
				ok: false,
				code: "not_local",
				message: `embedding model "${resolved.full}" is not approved for local-only input`,
			};
		}
		if (texts.length === 0) {
			return { ok: true, model: resolved.full, dimensions: resolved.model.dimensions, vectors: [] };
		}

		const contribution = resolved.entry.declaration.contribution;

		// 2b. Credential — core decides not_configured, never the tracker alone (the
		//    decisions precedent: the tracker cannot read auth.json, so gating on
		//    it before resolving the credential would deadlock a keyed install
		//    on the default endpoint — the provider's first call is the only way
		//    the tracker learns a key exists).
		let credential: string | undefined;
		try {
			credential = await deps.credential(contribution.id, contribution.credentialEnv);
			if (credential === "") credential = undefined;
		} catch {
			return { ok: false, code: "failed", message: "could not resolve the embedding credential" };
		}
		if (
			credential === undefined &&
			readiness(contribution) === "not_configured"
		) {
			return {
				ok: false,
				code: "not_configured",
				message: `embedding provider "${contribution.id}" is not configured`,
			};
		}

		// 3. One deadline covers all sequential batches; caller cancellation links
		//    to the same signal. Caller abort has no separate contract code.
		const deadlineMs = Math.min(opts.timeoutMs ?? settings.timeoutCapMs, settings.timeoutCapMs);
		const controller = new AbortController();
		let timedOut = false;
		let callerAborted = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, deadlineMs);
		const onCallerAbort = () => {
			callerAborted = true;
			controller.abort();
		};
		opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
		if (opts.signal?.aborted === true) onCallerAbort();
		if (callerAborted) {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onCallerAbort);
			return { ok: false, code: "failed", message: "aborted by the caller" };
		}

		const vectors: Float32Array[] = [];
		try {
			// Loader validation forbids zero; keep direct registry construction safe too.
			const maxBatch = Math.max(1, resolved.model.maxBatch ?? texts.length);
			for (let start = 0; start < texts.length; start += maxBatch) {
				const input = texts.slice(start, start + maxBatch);
				const response = await contribution.embed(
					{ model: resolved.model.id, input },
					{ credential, signal: controller.signal },
				);
				if (!Array.isArray(response?.vectors) || response.vectors.length !== input.length) {
					return {
						ok: false,
						code: "bad_response",
						message: `embedding provider "${contribution.id}" returned the wrong vector count`,
					};
				}
				for (const vector of response.vectors) {
					if (!Array.isArray(vector) || vector.length !== resolved.model.dimensions) {
						return {
							ok: false,
							code: "bad_response",
							message: `embedding provider "${contribution.id}" returned the wrong vector dimensions`,
						};
					}
					if (vector.some((element) => typeof element !== "number" || !Number.isFinite(element))) {
						return {
							ok: false,
							code: "bad_response",
							message: `embedding provider "${contribution.id}" returned a non-finite vector element`,
						};
					}
					const converted = Float32Array.from(vector);
					if (converted.some((element) => !Number.isFinite(element))) {
						return {
							ok: false,
							code: "bad_response",
							message: `embedding provider "${contribution.id}" returned a vector outside Float32 range`,
						};
					}
					vectors.push(converted);
				}
			}
		} catch (err) {
			if (timedOut) {
				return { ok: false, code: "timeout", message: `embedding timed out after ${deadlineMs}ms` };
			}
			if (callerAborted) return { ok: false, code: "failed", message: "aborted by the caller" };
			return { ok: false, code: "failed", message: safeFailureMessage(err, credential, texts) };
		} finally {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onCallerAbort);
		}
		if (timedOut) {
			return { ok: false, code: "timeout", message: `embedding timed out after ${deadlineMs}ms` };
		}
		if (callerAborted) return { ok: false, code: "failed", message: "aborted by the caller" };
		if (vectors.length !== texts.length) {
			return {
				ok: false,
				code: "bad_response",
				message: `embedding provider "${contribution.id}" returned the wrong vector count`,
			};
		}
		return { ok: true, model: resolved.full, dimensions: resolved.model.dimensions, vectors };
	}

	return {
		embed,
		list() {
			let settings: ReturnType<typeof deps.settings>;
			try {
				settings = deps.settings();
			} catch {
				return [];
			}
			const configuredDefault = settings.embeddingModel;
			const out: {
				model: string;
				provider: string;
				dimensions: number;
				local: boolean;
				default: boolean;
				status: ProviderReadiness["status"];
			}[] = [];
			for (const entry of entries.values()) {
				const contribution = entry.declaration.contribution;
				const status = readiness(contribution);
				for (const model of contribution.models) {
					const qualified = `${contribution.id}/${model.id}`;
					out.push({
						model: qualified,
						provider: contribution.id,
						dimensions: model.dimensions,
						local: localityOf({ entry, model }),
						default: qualified === configuredDefault,
						status,
					});
				}
			}
			return out;
		},
		providers() {
			return [...entries.values()].map((entry) => ({
				id: entry.declaration.contribution.id,
				label: entry.declaration.contribution.label,
				extension: entry.declaration.extension,
				models: entry.declaration.contribution.models.map((model) => model.id),
				status: readiness(entry.declaration.contribution),
			}));
		},
		collisions() {
			return collisionList;
		},
	};
}
