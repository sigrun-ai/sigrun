/**
 * Task 1 (knowledge plan): the published-hook registry — the pure core of
 * the extension-to-extension call seam. Given the loader's declarations
 * (configured extensions first, then built-ins; first per name owns), it
 * builds a registry whose `call` validates the payload against the
 * provider's compiled input schema, resolves the acting-user identity,
 * runs the provider under a linked abort controller plus a deadline, and
 * bounds payload size, result size, and recursion depth. `call` NEVER
 * throws; validators compile ONCE here at build, and a schema that fails
 * `Compile` throws FROM THE BUILD (Task 2 turns that into a load-time
 * quarantine, so the build never sees one in production).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Compile } from "typebox/compile";
import type { Validator } from "typebox/compile";
import type { TSchema } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type {
	PublishedHook,
	PublishedHookCall,
	PublishedHookDeclaration,
	PublishedHookResult,
} from "../extension.js";

/** Legal hook names: dotted lowercase segments (`memory.recall`). */
export const PUBLISHED_HOOK_NAME: RegExp = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** Hook names are also bounded in length. */
export const PUBLISHED_HOOK_NAME_MAX_CHARS = 128;

/** Maximum hook-call nesting before `failed/too-deep`. */
export const PUBLISHED_HOOK_MAX_DEPTH = 4;

/** Payload and result size cap (1 MiB of JSON). */
export const PUBLISHED_HOOK_MAX_BYTES = 1_048_576;

const depthStorage = new AsyncLocalStorage<number>();

interface Entry {
	readonly declaration: PublishedHookDeclaration;
	readonly input: Validator;
	readonly output: Validator | undefined;
}

export interface PublishedHookRegistry {
	get(name: string): { provider: string; input: TSchema; output?: TSchema } | undefined;
	call(
		caller: string,
		name: string,
		payload: unknown,
		opts?: {
			user?: string;
			conversationId?: ConversationId;
			abortSignal?: AbortSignal;
		},
	): Promise<PublishedHookResult>;
	listing(): readonly { name: string; provider: string; shadowed: readonly string[] }[];
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function describeErrors(validator: Validator, value: unknown): { path: string; message: string }[] {
	const out: { path: string; message: string }[] = [];
	for (const err of validator.Errors(value)) {
		out.push({ path: err.instancePath, message: err.message ?? "invalid" });
	}
	return out.length > 0 ? out : [{ path: "", message: "invalid" }];
}

export function buildPublishedHookRegistry(
	declarations: readonly PublishedHookDeclaration[],
	deps: {
		actingUser(id: ConversationId): Promise<string | undefined>;
		deadlineMs: number;
		warn(message: string): void;
	},
): PublishedHookRegistry {
	// Ownership: the declarations arrive in loader order; configured
	// extensions sort BEFORE built-ins regardless of arrival order, and
	// the first per name owns it. Shadowed providers record under the
	// owner (configured losers BEFORE built-in losers) and each loser
	// warns once.
	const ordered = [...declarations].sort((a, b) => Number(a.builtin) - Number(b.builtin));
	const owners = new Map<string, Entry>();
	const shadowedBy = new Map<string, string[]>();
	for (const declaration of ordered) {
		const hook: PublishedHook = declaration.hook;
		const existing = owners.get(hook.name);
		if (existing) {
			const owner = existing.declaration.extension;
			const loser = declaration.extension;
			const advice = declaration.builtin
				? `replace the built-in ${loser} by package name, or remove ${owner}`
				: "reorder extensions[] to switch";
			deps.warn(`published hook "${hook.name}": owned by ${owner}, shadowed ${loser} — ${advice}`);
			const list = shadowedBy.get(hook.name);
			if (list) list.push(loser);
			else shadowedBy.set(hook.name, [loser]);
			continue;
		}
		owners.set(hook.name, {
			declaration,
			input: Compile(hook.input),
			output: hook.output !== undefined ? Compile(hook.output) : undefined,
		});
	}

	async function call(
		caller: string,
		name: string,
		payload: unknown,
		opts: {
			user?: string;
			conversationId?: ConversationId;
			abortSignal?: AbortSignal;
		} = {},
	): Promise<PublishedHookResult> {
		// Depth is checked BEFORE ownership lookup so a nested call under
		// an unknown name still reports too-deep rather than absent.
		const depth = depthStorage.getStore() ?? 0;
		if (depth >= PUBLISHED_HOOK_MAX_DEPTH) {
			return {
				status: "failed",
				provider: owners.get(name)?.declaration.extension ?? "?",
				reason: "too-deep",
				error: `published hook depth ${depth + 1} exceeds ${PUBLISHED_HOOK_MAX_DEPTH}`,
			};
		}

		const entry = owners.get(name);
		if (!entry) return { status: "absent" };
		const provider = entry.declaration.extension;

		let serialized: string;
		try {
			serialized = JSON.stringify(payload);
		} catch (err) {
			return {
				status: "rejected",
				provider,
				errors: [{ path: "", message: `payload is not JSON-serializable: ${errorMessage(err)}` }],
			};
		}
		if (serialized.length > PUBLISHED_HOOK_MAX_BYTES) {
			return {
				status: "rejected",
				provider,
				errors: [
					{
						path: "",
						message: `payload is ${serialized.length} bytes; the cap is ${PUBLISHED_HOOK_MAX_BYTES}`,
					},
				],
			};
		}

		if (!entry.input.Check(payload)) {
			return { status: "rejected", provider, errors: describeErrors(entry.input, payload) };
		}

		let user: string | undefined;
		if (opts.conversationId !== undefined) {
			user = await deps.actingUser(opts.conversationId);
			if (opts.user !== undefined && opts.user !== user) {
				return {
					status: "rejected",
					provider,
					errors: [
						{
							path: "user",
							message: `caller declares user "${opts.user}" but the conversation's acting user is "${user ?? "unknown"}"`,
						},
					],
				};
			}
		} else {
			user = opts.user;
		}

		const controller = new AbortController();
		let timedOut = false;
		let callerAborted = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, deps.deadlineMs);
		const onCallerAbort = () => {
			callerAborted = true;
			controller.abort();
		};
		opts.abortSignal?.addEventListener("abort", onCallerAbort, { once: true });

		const hookCall: PublishedHookCall = {
			caller,
			user,
			conversationId: opts.conversationId,
			abortSignal: controller.signal,
		};

		let value: unknown;
		try {
			value = await depthStorage.run(depth + 1, () => entry.declaration.hook.run(payload, hookCall));
		} catch (err) {
			const reason = timedOut ? "timeout" : callerAborted ? "aborted" : "threw";
			return { status: "failed", provider, reason, error: errorMessage(err) };
		} finally {
			clearTimeout(timer);
			opts.abortSignal?.removeEventListener("abort", onCallerAbort);
		}

		let resultJson: string;
		try {
			resultJson = JSON.stringify(value);
		} catch (err) {
			return {
				status: "failed",
				provider,
				reason: "too-large",
				error: `result is not JSON-serializable: ${errorMessage(err)}`,
			};
		}
		if (resultJson.length > PUBLISHED_HOOK_MAX_BYTES) {
			return {
				status: "failed",
				provider,
				reason: "too-large",
				error: `result is ${resultJson.length} bytes; the cap is ${PUBLISHED_HOOK_MAX_BYTES}`,
			};
		}

		if (entry.output && !entry.output.Check(value)) {
			const first = describeErrors(entry.output, value)[0];
			return {
				status: "failed",
				provider,
				reason: "bad-output",
				error: `result fails the declared output schema at ${first?.path ?? ""}: ${first?.message ?? "invalid"}`,
			};
		}

		return { status: "ok", provider, value };
	}

	return {
		get(name) {
			const entry = owners.get(name);
			if (!entry) return undefined;
			return {
				provider: entry.declaration.extension,
				input: entry.declaration.hook.input,
				output: entry.declaration.hook.output,
			};
		},
		call,
		listing() {
			return [...owners.entries()].map(([name, entry]) => ({
				name,
				provider: entry.declaration.extension,
				shadowed: shadowedBy.get(name) ?? [],
			}));
		},
	};
}
