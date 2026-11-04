/**
 * Task 1: the pure published-hook registry — ownership resolution,
 * payload/result validation, identity checks, and the size/depth/deadline
 * bounds. Pure: no loader, no harness; declarations are built inline and
 * the identity oracle (`actingUser`) is a test stub.
 */

import { describe, expect, test, vi } from "vitest";
import { Type } from "typebox";
import {
	buildPublishedHookRegistry,
	PUBLISHED_HOOK_MAX_BYTES,
	PUBLISHED_HOOK_MAX_DEPTH,
	PUBLISHED_HOOK_NAME,
	type PublishedHookRegistry,
} from "../src/harness/published-hooks.js";
import type {
	PublishedHook,
	PublishedHookCall,
	PublishedHookDeclaration,
} from "../src/extension.js";
import type { ConversationId } from "@earendil-works/pi-durable";

function hook(
	name: string,
	run: PublishedHook["run"] = async () => "value",
	over: Partial<PublishedHook> = {},
): PublishedHook {
	return {
		name,
		input: Type.Object({ text: Type.String() }),
		run,
		...over,
	};
}

function decl(
	extension: string,
	builtin: boolean,
	h: PublishedHook,
): PublishedHookDeclaration {
	return { extension, builtin, hook: h };
}

const noopWarn = () => {};

function registry(
	declarations: readonly PublishedHookDeclaration[],
	deps: Partial<Parameters<typeof buildPublishedHookRegistry>[1]> = {},
): PublishedHookRegistry {
	return buildPublishedHookRegistry(declarations, {
		actingUser: async () => undefined,
		deadlineMs: 5_000,
		warn: noopWarn,
		...deps,
	});
}

const CONV = "conv-1" as unknown as ConversationId;

describe("name pattern", () => {
	test("accepts dotted lowercase names and rejects the rest", () => {
		expect(PUBLISHED_HOOK_NAME.test("memory.recall")).toBe(true);
		expect(PUBLISHED_HOOK_NAME.test("a.b.c")).toBe(true);
		expect(PUBLISHED_HOOK_NAME.test("x1.y-2")).toBe(true);
		expect(PUBLISHED_HOOK_NAME.test("nodot")).toBe(false);
		expect(PUBLISHED_HOOK_NAME.test("Trailing.")).toBe(false);
		expect(PUBLISHED_HOOK_NAME.test("has_under.score")).toBe(false);
		expect(PUBLISHED_HOOK_NAME.test("a..b")).toBe(false);
		expect(PUBLISHED_HOOK_NAME.test("")).toBe(false);
	});
});

describe("call", () => {
	test("absent for an unknown name", async () => {
		const r = registry([]);
		expect(await r.call("ext-a", "no.such", {})).toEqual({ status: "absent" });
	});

	test("ok carries the provider name and the value", async () => {
		const r = registry([decl("ext-a", false, hook("memory.recall"))]);
		const result = await r.call("ext-b", "memory.recall", { text: "hi" });
		expect(result).toEqual({ status: "ok", provider: "ext-a", value: "value" });
	});

	test("rejected names instancePath for a payload failing the schema and never runs the provider", async () => {
		const run = vi.fn(async () => "value");
		const r = registry([decl("ext-a", false, hook("memory.recall", run))]);
		const result = await r.call("ext-b", "memory.recall", { text: 42 });
		expect(result.status).toBe("rejected");
		if (result.status !== "rejected") throw new Error("unreachable");
		expect(result.provider).toBe("ext-a");
		expect(result.errors[0]?.path).toBe("/text");
		expect(run).not.toHaveBeenCalled();
	});

	test("rejected for a payload over 1 MiB and never runs the provider", async () => {
		const run = vi.fn(async () => "value");
		const r = registry([decl("ext-a", false, hook("memory.recall", run))]);
		const result = await r.call("ext-b", "memory.recall", {
			text: "x".repeat(PUBLISHED_HOOK_MAX_BYTES),
		});
		expect(result.status).toBe("rejected");
		if (result.status !== "rejected") throw new Error("unreachable");
		expect(result.errors[0]?.path).toBe("");
		expect(run).not.toHaveBeenCalled();
	});

	test("rejected for an unstringifiable payload (path \"\")", async () => {
		const run = vi.fn(async () => "value");
		const r = registry([
			decl("ext-a", false, hook("memory.recall", run, { input: Type.Any() })),
		]);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const result = await r.call("ext-b", "memory.recall", cyclic);
		expect(result.status).toBe("rejected");
		if (result.status !== "rejected") throw new Error("unreachable");
		expect(result.errors[0]?.path).toBe("");
		expect(run).not.toHaveBeenCalled();
	});

	test("failed/too-large for a result over 1 MiB", async () => {
		const r = registry([
			decl("ext-a", false, hook("memory.recall", async () => "x".repeat(PUBLISHED_HOOK_MAX_BYTES))),
		]);
		const result = await r.call("ext-b", "memory.recall", { text: "hi" });
		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("unreachable");
		expect(result.reason).toBe("too-large");
		expect(result.provider).toBe("ext-a");
	});

	test("failed/bad-output when the value fails the declared output schema", async () => {
		const r = registry([
			decl(
				"ext-a",
				false,
				hook("memory.recall", async () => 42, { output: Type.String() }),
			),
		]);
		const result = await r.call("ext-b", "memory.recall", { text: "hi" });
		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("unreachable");
		expect(result.reason).toBe("bad-output");
	});

	test("failed/threw when the provider throws", async () => {
		const r = registry([
			decl("ext-a", false, hook("memory.recall", async () => {
				throw new Error("boom");
			})),
		]);
		const result = await r.call("ext-b", "memory.recall", { text: "hi" });
		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("unreachable");
		expect(result.reason).toBe("threw");
		expect(result.error).toContain("boom");
	});

	test("failed/timeout aborts the provider when the deadline fires first", async () => {
		let seen: AbortSignal | undefined;
		const r = registry(
			[
				decl("ext-a", false, hook("memory.recall", (_p, call) => {
					seen = call.abortSignal;
					return new Promise((_resolve, reject) => {
						call.abortSignal?.addEventListener("abort", () =>
							reject(new Error("aborted")),
						);
					});
				})),
			],
			{ deadlineMs: 20 },
		);
		const result = await r.call("ext-b", "memory.recall", { text: "hi" });
		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("unreachable");
		expect(result.reason).toBe("timeout");
		expect(seen?.aborted).toBe(true);
	});

	test("failed/aborted when the caller aborts", async () => {
		const caller = new AbortController();
		const r = registry([
			decl("ext-a", false, hook("memory.recall", (_p, call) =>
				new Promise((_resolve, reject) => {
					call.abortSignal?.addEventListener("abort", () =>
						reject(new Error("aborted")),
					);
				}),
			)),
		]);
		const pending = r.call("ext-b", "memory.recall", { text: "hi" }, { abortSignal: caller.signal });
		await new Promise((resolve) => setTimeout(resolve, 5));
		caller.abort();
		const result = await pending;
		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("unreachable");
		expect(result.reason).toBe("aborted");
	});

	test("failed/too-deep at depth 5 for a hook that calls itself", async () => {
		let maxDepth = 0;
		let innerReason: string | undefined;
		let r: PublishedHookRegistry;
		const self: PublishedHook = {
			name: "loop.self",
			input: Type.Object({ text: Type.String() }),
			async run(payload, call) {
				maxDepth += 1;
				const inner = await r.call(call.caller, "loop.self", payload);
				if (inner.status === "failed") innerReason = inner.reason;
				return JSON.stringify(inner);
			},
		};
		r = registry([decl("ext-a", false, self)]);
		const result = await r.call("ext-b", "loop.self", { text: "hi" });
		expect(result.status).toBe("ok");
		if (result.status !== "ok") throw new Error("unreachable");
		// depths 1..4 run; depth 5 is refused with failed/too-deep.
		expect(String(result.value)).toContain("too-deep");
		expect(innerReason).toBe("too-deep");
		expect(maxDepth).toBe(PUBLISHED_HOOK_MAX_DEPTH);
	});
});

describe("identity", () => {
	test("with conversationId the provider sees actingUser's user", async () => {
		let seen: PublishedHookCall | undefined;
		const r = registry(
			[decl("ext-a", false, hook("memory.recall", async (_p, call) => {
				seen = call;
				return "value";
			}))],
			{ actingUser: async (id: ConversationId) => (id === CONV ? "bob" : undefined) },
		);
		const result = await r.call("ext-b", "memory.recall", { text: "hi" }, { conversationId: CONV });
		expect(result.status).toBe("ok");
		expect(seen?.user).toBe("bob");
		expect(seen?.conversationId).toBe(CONV);
	});

	test("conversationId owned by bob plus user \"alice\" is rejected with path \"user\" and the provider never runs", async () => {
		const run = vi.fn(async () => "value");
		const r = registry(
			[decl("ext-a", false, hook("memory.recall", run))],
			{ actingUser: async () => "bob" },
		);
		const result = await r.call(
			"ext-b",
			"memory.recall",
			{ text: "hi" },
			{ conversationId: CONV, user: "alice" },
		);
		expect(result.status).toBe("rejected");
		if (result.status !== "rejected") throw new Error("unreachable");
		expect(result.errors.some((e) => e.path === "user")).toBe(true);
		expect(run).not.toHaveBeenCalled();
	});

	test("without conversationId the caller's user passes through", async () => {
		let seen: PublishedHookCall | undefined;
		const r = registry([
			decl("ext-a", false, hook("memory.recall", async (_p, call) => {
				seen = call;
				return "value";
			})),
		]);
		const result = await r.call("ext-b", "memory.recall", { text: "hi" }, { user: "carol" });
		expect(result.status).toBe("ok");
		expect(seen?.user).toBe("carol");
		expect(seen?.conversationId).toBeUndefined();
	});
});

describe("ownership", () => {
	test("the first configured declaration owns; a later configured one is shadowed with the reorder text", async () => {
		const warnings: string[] = [];
		const r = registry(
			[
				decl("ext-a", false, hook("memory.recall", async () => "from-a")),
				decl("ext-b", false, hook("memory.recall", async () => "from-b")),
			],
			{ warn: (m) => warnings.push(m) },
		);
		const result = await r.call("ext-c", "memory.recall", { text: "hi" });
		expect(result).toEqual({ status: "ok", provider: "ext-a", value: "from-a" });
		expect(warnings).toEqual([
			'published hook "memory.recall": owned by ext-a, shadowed ext-b — reorder extensions[] to switch',
		]);
	});

	test("a configured declaration beats an earlier-loaded built-in; the built-in loser's warning names replacing the built-in", async () => {
		const warnings: string[] = [];
		const r = registry(
			[
				decl("builtin-x", true, hook("memory.recall", async () => "from-builtin")),
				decl("ext-a", false, hook("memory.recall", async () => "from-configured")),
			],
			{ warn: (m) => warnings.push(m) },
		);
		const result = await r.call("ext-c", "memory.recall", { text: "hi" });
		expect(result).toEqual({ status: "ok", provider: "ext-a", value: "from-configured" });
		expect(warnings).toEqual([
			'published hook "memory.recall": owned by ext-a, shadowed builtin-x — replace the built-in builtin-x by package name, or remove ext-a',
		]);
	});

	test("listing reports owner and shadowed providers", () => {
		const r = registry([
			decl("builtin-x", true, hook("memory.recall")),
			decl("ext-a", false, hook("memory.recall")),
			decl("ext-b", false, hook("memory.recall")),
			decl("ext-c", false, hook("other.hook")),
		]);
		expect(r.listing()).toEqual([
			{ name: "memory.recall", provider: "ext-a", shadowed: ["ext-b", "builtin-x"] },
			{ name: "other.hook", provider: "ext-c", shadowed: [] },
		]);
	});

	test("get returns the owner's schemas", () => {
		const output = Type.String();
		const r = registry([decl("ext-a", false, hook("memory.recall", async () => "v", { output }))]);
		const got = r.get("memory.recall");
		expect(got?.provider).toBe("ext-a");
		expect(got?.output).toBe(output);
		expect(r.get("no.such")).toBeUndefined();
	});
});
