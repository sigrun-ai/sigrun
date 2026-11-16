/**
 * `sigrun.lean-retry` — the crash guard that makes the NEXT attempt of a
 * conversation's request skip extension `pi.generation` request hooks.
 *
 * WHY THIS EXISTS. When the host dies while a model request is being
 * PREPARED (typically inside an extension `beforeRequest` /
 * `beforeProviderRequest` handler), pi-durable counts the death as a
 * failed attempt, resumes the generation on the next boot, and re-runs
 * the SAME hooks on every attempt — so ONE bad request can kill the
 * server `settings.retry` times in a row. A crashed preparation is not
 * PROOF that a hook caused it (attribution-free ruling), so the retry
 * runs without any extension request hooks at all: only additions are
 * dropped, the request body the extension never edited is sent as-is.
 *
 * THE MECHANISM. The first wrapped request hook of an attempt writes a
 * small JSON marker file `<dir>/<conversationId>.json` =
 * `{conversationId, taskId, at}` BEFORE calling the extension. The core
 * `sigrun.lean-retry` extension's `afterResponse` removes it
 * synchronously — that is the ONLY clear (a provider message reached
 * classification, so the request phase is over; clearing on `runSettled`
 * would race the NEXT run's record because that delivery is
 * asynchronous). At boot, before `harness.resume()`, `recover(inspection)`
 * reads every marker; a marker whose conversation has an unfinished
 * `pi.generation` task keeps it and marks the conversation LEAN (every
 * later attempt in that conversation skips extension request hooks
 * until a provider response arrives). A marker with no live generation
 * task means the host died during preparation of a run that already
 * ended some other way — deleted, no lean attempt, no notice.
 *
 * Core-owned extensions (installed by boot, not by the loader) are NOT
 * wrapped by design: the marker wrap lives in the loader's install path.
 */

import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	openNodeSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	Harness,
	GenerationTask,
	hook,
	defineExtension,
	type ConversationId,
	type Extension,
	type HarnessInspection,
	type HookApi,
	type JsonObject,
	type TaskId,
	type TaskInspection,
} from "@earendil-works/pi-durable";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { createLeanRetry, LEAN_RETRY_EXTENSION } from "../src/harness/lean-retry.js";
import { createRegistry } from "../src/harness/registry.js";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { seededIdentity } from "./helpers/identity.js";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "sigrun-lean-retry-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** An inspection fake: tasks for the listed conversations. */
function inspectionOf(
	entries: readonly {
		readonly conversationId: ConversationId;
		readonly taskId?: TaskId;
		readonly kind?: string;
		readonly stateKind?: "pending" | "running" | "sleeping" | "waiting" | "completing" | "blocked";
	}[],
): HarnessInspection {
	const tasks: TaskInspection[] = entries.map(
		({ conversationId, taskId, kind = "pi.generation", stateKind = "pending" }) =>
			({
				record: {
					id: taskId ?? (1 as TaskId),
					conversationId,
					kind,
					version: 1,
					input: {},
					background: false,
					abortRequested: false,
				},
				state:
					stateKind === "blocked"
						? { kind: "blocked", reason: "missing_task" }
						: stateKind === "sleeping"
							? { kind: "sleeping", until: Date.now() + 1_000 }
							: stateKind === "waiting"
								? { kind: "waiting", on: [] }
								: stateKind === "completing"
									? { kind: "completing" }
									: { kind: stateKind },
			}) as unknown as TaskInspection,
	);
	return { scheduling: "paused", tasks, submissions: [] };
}

/** A fake `HookApi` carrying only what the wrapper touches. */
function hookApi(
	conversationId: ConversationId,
	taskId: TaskId = 42 as TaskId,
): HookApi {
	return { conversationId, taskId } as unknown as HookApi;
}

/** A pi.generation hook extension whose request hooks we can count. */
function makeRequestHookExtension(
	counters: { before: number; provider: number },
): Extension {
	return defineExtension({
		name: "fixture-request-hooks",
		hooks: [
			hook(GenerationTask, {
				beforeRequest(request: { readonly messages: readonly unknown[] }) {
					counters.before++;
					return request as never;
				},
				beforeProviderRequest(request: { readonly payload: unknown }) {
					counters.provider++;
					return request as never;
				},
			}),
		],
	});
}

/** Read the marker file for `conversationId` as JSON. */
function readMarker(conversationId: ConversationId): JsonObject {
	return JSON.parse(
		readFileSync(join(dir, `${conversationId}.json`), "utf8"),
	) as JsonObject;
}

/** Direct marker write for recover-side tests. */
async function writeMarker(
	conversationId: ConversationId,
	taskId: TaskId = 42 as TaskId,
	at = 1_700_000_000_000,
): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, `${conversationId}.json`),
		JSON.stringify({ conversationId, taskId, at }),
	);
}

describe("the record and its clear", () => {
	test("the wrapped beforeRequest writes the record BEFORE the extension handler runs", async () => {
		const lean = createLeanRetry({ dir });
		let sawMarker = false;
		const cid = 101 as ConversationId;
		const tid = 7 as TaskId;
		const extension = defineExtension({
			name: "fixture-record-order",
			hooks: [
				hook(GenerationTask, {
					beforeRequest() {
						sawMarker = existsSync(join(dir, `${cid}.json`));
						return undefined;
					},
				}),
			],
		});
		const wrapped = lean.wrapExtension(extension);
		const registration = wrapped.hooks![0];
		expect(registration.task).toBe("pi.generation");
		const handler = (registration.handlers as {
			beforeRequest: (
				request: { readonly messages: readonly unknown[] },
				api: HookApi,
			) => unknown;
		}).beforeRequest;
		await handler({ messages: [] }, hookApi(cid, tid));
		expect(sawMarker).toBe(true);
		expect(readMarker(cid)).toMatchObject({
			conversationId: cid,
			taskId: tid,
		});
	});

	test("beforeProviderRequest writes the same record then calls the extension", async () => {
		const lean = createLeanRetry({ dir });
		const cid = 102 as ConversationId;
		const tid = 8 as TaskId;
		const counters = { before: 0, provider: 0 };
		const wrapped = lean.wrapExtension(makeRequestHookExtension(counters));
		const handlers = wrapped.hooks![0].handlers as {
			beforeProviderRequest: (
				request: { readonly model: unknown; readonly payload: unknown },
				api: HookApi,
			) => unknown;
		};
		await handlers.beforeProviderRequest(
			{ model: { id: "m", api: "openai" }, payload: { a: 1 } },
			hookApi(cid, tid),
		);
		expect(counters.provider).toBe(1);
		expect(readMarker(cid)).toMatchObject({
			conversationId: cid,
			taskId: tid,
		});
	});

	test("a second attempt of the same task does NOT rewrite the record", async () => {
		const lean = createLeanRetry({ dir });
		const cid = 103 as ConversationId;
		const tid = 9 as TaskId;
		const wrapped = lean.wrapExtension(
			defineExtension({
				name: "fixture-no-rewrite",
				hooks: [hook(GenerationTask, { beforeRequest() { return undefined; } })],
			}),
		);
		const handlers = wrapped.hooks![0].handlers as {
			beforeRequest: (
				request: { readonly messages: readonly unknown[] },
				api: HookApi,
			) => unknown;
		};
		await handlers.beforeRequest({ messages: [] }, hookApi(cid, tid));
		// Bump the marker's at to a sentinel, then re-run the hook: a same-task
		// re-entry must leave the sentinel alone (only taskId re-stamps).
		await writeMarker(cid, tid, 999_999);
		await handlers.beforeRequest({ messages: [] }, hookApi(cid, tid));
		expect(readMarker(cid).at).toBe(999_999);
	});

	test("a NEW taskId re-stamps the record", async () => {
		const lean = createLeanRetry({ dir });
		const cid = 104 as ConversationId;
		const wrapped = lean.wrapExtension(
			defineExtension({
				name: "fixture-restamp",
				hooks: [hook(GenerationTask, { beforeRequest() { return undefined; } })],
			}),
		);
		const handlers = wrapped.hooks![0].handlers as {
			beforeRequest: (
				request: { readonly messages: readonly unknown[] },
				api: HookApi,
			) => unknown;
		};
		await handlers.beforeRequest({ messages: [] }, hookApi(cid, 1 as TaskId));
		await handlers.beforeRequest({ messages: [] }, hookApi(cid, 2 as TaskId));
		expect(readMarker(cid).taskId).toBe(2);
	});

	test("the core extension's afterResponse removes the record and un-lean the conversation", async () => {
		const lean = createLeanRetry({ dir });
		const cid = 105 as ConversationId;
		await writeMarker(cid);
		// Mark lean via a recover that returns this conversation.
		const kept = lean.recover(inspectionOf([{ conversationId: cid }]));
		expect(kept).toEqual([cid]);
		expect(lean.isLean(cid)).toBe(true);
		// afterResponse removes the file and ends lean.
		const core = lean.extension;
		expect(core.name).toBe(LEAN_RETRY_EXTENSION);
		const handlers = core.hooks![0].handlers as {
			afterResponse: (message: unknown, api: HookApi) => unknown;
		};
		await handlers.afterResponse({ role: "assistant" }, hookApi(cid, 42 as TaskId));
		expect(existsSync(join(dir, `${cid}.json`))).toBe(false);
		expect(lean.isLean(cid)).toBe(false);
	});

	test("afterResponse with no record on disk is a no-op (rmSync force)", async () => {
		const lean = createLeanRetry({ dir });
		const cid = 106 as ConversationId;
		const core = lean.extension;
		const handlers = core.hooks![0].handlers as {
			afterResponse: (message: unknown, api: HookApi) => unknown;
		};
		await Promise.resolve(
			handlers.afterResponse({ role: "assistant" }, hookApi(cid, 42 as TaskId)),
		);
		// No file is created, no throw.
		expect(existsSync(join(dir, `${cid}.json`))).toBe(false);
	});
});

describe("recover", () => {
	test("a marker with an unfinished pending generation task keeps the conversation lean", async () => {
		const lean = createLeanRetry({ dir });
		const cid = 201 as ConversationId;
		await writeMarker(cid);
		const recovered = lean.recover(inspectionOf([{ conversationId: cid }]));
		expect(recovered).toEqual([cid]);
		expect(lean.isLean(cid)).toBe(true);
	});

	test("a marker whose conversation has NO live generation task is deleted and NOT lean (Review Focus 5)", async () => {
		const lean = createLeanRetry({ dir });
		const cid = 202 as ConversationId;
		await writeMarker(cid);
		const recovered = lean.recover(inspectionOf([]));
		expect(recovered).toEqual([]);
		expect(lean.isLean(cid)).toBe(false);
		expect(existsSync(join(dir, `${cid}.json`))).toBe(false);
	});

	test("a marker for a BLOCKED generation task is deleted (no live work)", async () => {
		const lean = createLeanRetry({ dir });
		const cid = 203 as ConversationId;
		await writeMarker(cid);
		const recovered = lean.recover(
			inspectionOf([{ conversationId: cid, stateKind: "blocked" }]),
		);
		expect(recovered).toEqual([]);
		expect(existsSync(join(dir, `${cid}.json`))).toBe(false);
	});

	test("recover twice in a row returns the same id when the lean attempt was itself cut off", async () => {
		const lean = createLeanRetry({ dir });
		const cid = 204 as ConversationId;
		await writeMarker(cid);
		const first = lean.recover(inspectionOf([{ conversationId: cid }]));
		expect(first).toEqual([cid]);
		// Simulate the cut-off lean attempt: the record persists (nothing
		// cleared it) and the generation is STILL pending at next boot.
		await writeMarker(cid); // idempotent re-seed (recover leaves it alone)
		const second = lean.recover(inspectionOf([{ conversationId: cid }]));
		expect(second).toEqual([cid]);
	});

	test("markers for non-generation kinds or other conversations are deleted", async () => {
		const lean = createLeanRetry({ dir });
		const generation = 205 as ConversationId;
		const other = 206 as ConversationId;
		await writeMarker(generation);
		await writeMarker(other);
		const recovered = lean.recover(
			inspectionOf([
				{ conversationId: generation },
				{ conversationId: other, kind: "pi.tool" },
			]),
		);
		expect(recovered).toEqual([generation]);
		expect(existsSync(join(dir, `${other}.json`))).toBe(false);
	});
});

describe("wrapExtension", () => {
	test("an extension without pi.generation hooks is returned IDENTICAL (===)", () => {
		const lean = createLeanRetry({ dir });
		const extension = defineExtension({
			name: "no-hooks",
			tools: [],
			hooks: [hook(GenerationTask, { onYield() { return undefined; } })],
		});
		expect(lean.wrapExtension(extension)).toBe(extension);
		// Also: a hook registration of a DIFFERENT task stays identical.
		const other = defineExtension({ name: "no-generation-hooks" });
		expect(lean.wrapExtension(other)).toBe(other);
	});

	test("only beforeRequest / beforeProviderRequest are wrapped; other handlers identical", () => {
		const lean = createLeanRetry({ dir });
		const onYield = () => undefined;
		const afterResponse = () => undefined;
		const beforeRequest = (request: { readonly messages: readonly unknown[] }) => request as never;
		const extension = defineExtension({
			name: "mixed-handlers",
			hooks: [
				hook(GenerationTask, {
					beforeRequest,
					onYield,
					afterResponse,
				}),
			],
		});
		const wrapped = lean.wrapExtension(extension);
		expect(wrapped).not.toBe(extension);
		const handlers = wrapped.hooks![0].handlers as {
			beforeRequest: unknown;
			onYield: unknown;
			afterResponse: unknown;
		};
		expect(handlers.beforeRequest).not.toBe(beforeRequest);
		expect(handlers.onYield).toBe(onYield);
		expect(handlers.afterResponse).toBe(afterResponse);
	});

	test("a lean conversation skips extension request hooks entirely (returns undefined)", async () => {
		const lean = createLeanRetry({ dir });
		const cid = 301 as ConversationId;
		const counters = { before: 0, provider: 0 };
		const wrapped = lean.wrapExtension(makeRequestHookExtension(counters));
		const handlers = wrapped.hooks![0].handlers as {
			beforeRequest: (
				request: { readonly messages: readonly unknown[] },
				api: HookApi,
			) => unknown;
			beforeProviderRequest: (
				request: { readonly model: unknown; readonly payload: unknown },
				api: HookApi,
			) => unknown;
		};
		// Normal call: handler runs, record lands.
		const pass = await handlers.beforeRequest(
			{ messages: [] },
			hookApi(cid, 1 as TaskId),
		);
		expect(pass).toEqual({ messages: [] });
		expect(counters.before).toBe(1);
		// Mark lean and recover: the next call must NOT invoke the handler.
		lean.recover(inspectionOf([{ conversationId: cid }]));
		const skipped = await handlers.beforeRequest(
			{ messages: [] },
			hookApi(cid, 1 as TaskId),
		);
		expect(skipped).toBeUndefined();
		expect(counters.before).toBe(1);
		const skippedProvider = await handlers.beforeProviderRequest(
			{ model: { id: "m", api: "openai" }, payload: {} },
			hookApi(cid, 1 as TaskId),
		);
		expect(skippedProvider).toBeUndefined();
		expect(counters.provider).toBe(0);
	});

	test("after the core extension's afterResponse the handler is called again", async () => {
		const lean = createLeanRetry({ dir });
		const cid = 302 as ConversationId;
		const counters = { before: 0, provider: 0 };
		const wrapped = lean.wrapExtension(makeRequestHookExtension(counters));
		const handlers = wrapped.hooks![0].handlers as {
			beforeRequest: (
				request: { readonly messages: readonly unknown[] },
				api: HookApi,
			) => unknown;
		};
		lean.recover(inspectionOf([])); // nothing live initially — sets nothing lean
		await handlers.beforeRequest({ messages: [] }, hookApi(cid, 1 as TaskId));
		expect(counters.before).toBe(1);
		lean.recover(inspectionOf([{ conversationId: cid }]));
		await handlers.beforeRequest({ messages: [] }, hookApi(cid, 1 as TaskId));
		expect(counters.before).toBe(1);
		// Clear via the core extension's afterResponse.
		const core = lean.extension;
		const coreHandlers = core.hooks![0].handlers as {
			afterResponse: (message: unknown, api: HookApi) => unknown;
		};
		await coreHandlers.afterResponse(
			{ role: "assistant" },
			hookApi(cid, 1 as TaskId),
		);
		await handlers.beforeRequest({ messages: [] }, hookApi(cid, 2 as TaskId));
		expect(counters.before).toBe(2);
	});
});

describe("the core extension shape", () => {
	test("the extension is named `sigrun.lean-retry` and is hooks-only", () => {
		const lean = createLeanRetry({ dir });
		expect(lean.extension.name).toBe(LEAN_RETRY_EXTENSION);
		expect(lean.extension.tools).toBeUndefined();
		expect(lean.extension.sections).toBeUndefined();
		expect(lean.extension.hooks).toHaveLength(1);
		expect(lean.extension.hooks![0].task).toBe("pi.generation");
	});

	test("the marker dir's first write succeeds once boot has created it", async () => {
		// The factory itself does NOT create the dir (boot owns that with
		// `mkdirSync(dir, { recursive: true })`); this pins the wrapper's
		// write-after-boot-mkdir contract on a freshly-created nested root.
		const lazyDir = join(dir, "lazy", "nested");
		const lean = createLeanRetry({ dir: lazyDir });
		await mkdir(lazyDir, { recursive: true });
		const cid = 401 as ConversationId;
		const wrapped = lean.wrapExtension(
			defineExtension({
				name: "fixture-lazy-dir",
				hooks: [hook(GenerationTask, { beforeRequest() { return undefined; } })],
			}),
		);
		const handlers = wrapped.hooks![0].handlers as {
			beforeRequest: (
				request: { readonly messages: readonly unknown[] },
				api: HookApi,
			) => unknown;
		};
		await handlers.beforeRequest({ messages: [] }, hookApi(cid, 1 as TaskId));
		expect(existsSync(join(lazyDir, `${cid}.json`))).toBe(true);
		const files = await readdir(lazyDir);
		expect(files).toEqual([`${cid}.json`]);
	});

	test("the record is JSON-serializable with the documented shape", async () => {
		const lean = createLeanRetry({ dir });
		const cid = 402 as ConversationId;
		const tid = 100 as TaskId;
		const wrapped = lean.wrapExtension(
			defineExtension({
				name: "fixture-shape",
				hooks: [hook(GenerationTask, { beforeRequest() { return undefined; } })],
			}),
		);
		const handlers = wrapped.hooks![0].handlers as {
			beforeRequest: (
				request: { readonly messages: readonly unknown[] },
				api: HookApi,
			) => unknown;
		};
		await handlers.beforeRequest({ messages: [] }, hookApi(cid, tid));
		const raw = await readFile(join(dir, `${cid}.json`), "utf8");
		const parsed = JSON.parse(raw) as JsonObject;
		expect(Object.keys(parsed).sort()).toEqual(["at", "conversationId", "taskId"]);
		expect(parsed.conversationId).toBe(cid);
		expect(parsed.taskId).toBe(tid);
		expect(typeof parsed.at).toBe("number");
	});
});

describe("the wrapper's disk and binding contracts (review minors 3-7)", () => {
	test("the marker write is ATOMIC: content lands via tmp+renameSync, never torn", async () => {
		// The complete file is in place before/after; there is no window
		// where a reader sees a half-written record. Atomic tmp+rename makes
		// a mid-write crash leave either the OLD record or the NEW one.
		const lean = createLeanRetry({ dir });
		const cid = 501 as ConversationId;
		const wrapped = lean.wrapExtension(
			defineExtension({
				name: "fixture-atomic",
				hooks: [hook(GenerationTask, { beforeRequest() { return undefined; } })],
			}),
		);
		const handlers = wrapped.hooks![0].handlers as {
			beforeRequest: (
				request: { readonly messages: readonly unknown[] },
				api: HookApi,
			) => unknown;
		};
		await handlers.beforeRequest({ messages: [] }, hookApi(cid, 1 as TaskId));
		// No left-over tmp siblings: the directory contains ONLY the final
		// marker file. (The tmp file must never survive a successful write.)
		expect(readdirSync(dir).sort()).toEqual([`${cid}.json`]);
		// And the final file is a COMPLETE record (never truncated).
		const parsed = JSON.parse(readFileSync(join(dir, `${cid}.json`), "utf8"));
		expect(parsed).toMatchObject({ conversationId: cid, taskId: 1 });
		expect(typeof parsed.at).toBe("number");
	});

	test("record write failure FAILS OPEN: the handler is still invoked", async () => {
		const lean = createLeanRetry({ dir: join(dir, "does-not-exist") });
		let called = 0;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const wrapped = lean.wrapExtension(
				defineExtension({
					name: "fixture-fail-open",
					hooks: [
						hook(GenerationTask, {
							beforeRequest(request: { readonly messages: readonly unknown[] }) {
								called++;
								return request as never;
							},
						}),
					],
				}),
			);
			const handlers = wrapped.hooks![0].handlers as {
				beforeRequest: (
					request: { readonly messages: readonly unknown[] },
					api: HookApi,
				) => unknown;
			};
			const result = await handlers.beforeRequest(
				{ messages: [] },
				hookApi(502 as ConversationId, 1 as TaskId),
			);
			// The handler ran, and the caller sees its result — a disk hiccup
			// must not eat the request.
			expect(called).toBe(1);
			expect(result).toEqual({ messages: [] });
			// The failure was observed (a console.warn), not swallowed.
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	test("both wrapped request handlers preserve the caller-provided receiver", async () => {
		// pi-durable binds a hook to the handlers bag before invoking it
		// (`handler.bind(handlers)`, dist/harness/scheduler.js:2459).
		// A synthetic receiver exercises that binding without tying the
		// wrapper to one fixed registration bag; this assertion only checks
		// that the wrapper forwards the receiver.
		// Both `beforeRequest` and `beforeProviderRequest` must behave
		// identically, since either can be the first hook of an attempt.
		const lean = createLeanRetry({ dir });
		const observed: unknown[] = [];
		const handlers = {
			beforeRequest(request: { readonly messages: readonly unknown[] }) {
				observed.push(this);
				return request as never;
			},
			beforeProviderRequest(request: { readonly payload: unknown }) {
				observed.push(this);
				return { payload: request.payload };
			},
		};
		const registration = hook(GenerationTask, handlers);
		const extension = defineExtension({ name: "fixture-this", hooks: [registration] });
		const wrapped = lean.wrapExtension(extension);
		const boundHandlers = wrapped.hooks![0].handlers as {
			beforeRequest: (
				this: unknown,
				request: { readonly messages: readonly unknown[] },
				api: HookApi,
			) => unknown;
			beforeProviderRequest: (
				this: unknown,
				request: { readonly model: unknown; readonly payload: unknown },
				api: HookApi,
			) => unknown;
		};
		// A synthetic receiver stands in for the runtime's bound handlers
		// bag, so the assertions cannot accidentally rely on the handler
		// bag being identical to the ORIGINAL registration's.
		const syntheticReceiver = { tag: "hook-runtime-receiver" };
		await boundHandlers.beforeRequest.call(
			syntheticReceiver,
			{ messages: [] },
			hookApi(503 as ConversationId, 1 as TaskId),
		);
		await boundHandlers.beforeProviderRequest.call(
			syntheticReceiver,
			{ model: { id: "m", api: "openai" }, payload: {} },
			hookApi(503 as ConversationId, 1 as TaskId),
		);
		expect(observed).toEqual([syntheticReceiver, syntheticReceiver]);
	});

	test("EVERY pi.generation registration is wrapped, not only the first", async () => {
		const lean = createLeanRetry({ dir });
		const counts = { a: 0, b: 0 };
		const extension = defineExtension({
			name: "fixture-two-registrations",
			hooks: [
				hook(GenerationTask, {
					beforeRequest() { counts.a++; return undefined; },
				}),
				hook(GenerationTask, {
					beforeRequest() { counts.b++; return undefined; },
				}),
			],
		});
		const wrapped = lean.wrapExtension(extension);
		expect(wrapped).not.toBe(extension);
		// Both registrations' beforeRequest must write the same marker and
		// must independently observe the lean state.
		const cid = 504 as ConversationId;
		for (const registration of wrapped.hooks!) {
			const handlers = registration.handlers as {
				beforeRequest: (
					request: { readonly messages: readonly unknown[] },
					api: HookApi,
				) => unknown;
			};
			expect(typeof handlers.beforeRequest).toBe("function");
			await handlers.beforeRequest({ messages: [] }, hookApi(cid, 1 as TaskId));
		}
		expect(counts).toEqual({ a: 1, b: 1 });
		// After lean, NEITHER registration's beforeRequest runs.
		lean.recover(inspectionOf([{ conversationId: cid }]));
		for (const registration of wrapped.hooks!) {
			const handlers = registration.handlers as {
				beforeRequest: (
					request: { readonly messages: readonly unknown[] },
					api: HookApi,
				) => unknown;
			};
			const result = await handlers.beforeRequest(
				{ messages: [] },
				hookApi(cid, 1 as TaskId),
			);
			expect(result).toBeUndefined();
		}
		expect(counts).toEqual({ a: 1, b: 1 });
	});

	test("recover keys the lean set by the record CONTENT's conversationId, not the filename", async () => {
		// A non-numeric filename must not produce NaN in the lean set. The
		// record's own conversationId is the authority.
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "bogus-name.json"),
			JSON.stringify({ conversationId: 601, taskId: 1, at: 1_700_000_000_000 }),
		);
		const lean = createLeanRetry({ dir });
		const cid = 601 as ConversationId;
		const recovered = lean.recover(inspectionOf([{ conversationId: cid }]));
		expect(recovered).toEqual([cid]);
		expect(recovered.every((one) => typeof one === "number" && !Number.isNaN(one))).toBe(true);
		expect(lean.isLean(cid)).toBe(true);
	});

	test("a torn file (half-written record from the pre-atomic era) recovers as no-record", async () => {
		// Forward-compat for any write path that pre-dates tmp+rename: a
		// file whose content is truncated JSON is treated as absence of
		// evidence — deleted, not kept lean on a phantom conversation.
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "602.json"), "{\"conversationId\":602,\"taskId\":");
		const lean = createLeanRetry({ dir });
		const recovered = lean.recover(
			inspectionOf([{ conversationId: 602 as ConversationId }]),
		);
		expect(recovered).toEqual([]);
		expect(existsSync(join(dir, "602.json"))).toBe(false);
	});

	test("a marker whose content's conversationId is non-numeric is deleted, not kept", async () => {
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "603.json"),
			JSON.stringify({ conversationId: "not-a-number", taskId: 1, at: 1 }),
		);
		const lean = createLeanRetry({ dir });
		const recovered = lean.recover(
			inspectionOf([{ conversationId: 603 as ConversationId }]),
		);
		expect(recovered).toEqual([]);
		expect(existsSync(join(dir, "603.json"))).toBe(false);
	});
});

describe("boot-level recovery: marker + a real pending pi.generation task (minor 9)", () => {
	test("openHarness recovers the marker conversation into leanRetries and logs the count", { timeout: 20_000 }, async () => {
		const bootDir = await mkdtemp(join(tmpdir(), "sigrun-lean-boot-"));
		const storagePath = join(bootDir, "sigrun.db");
		let rawHarness: Harness | undefined;
		let rootId: ConversationId = 0 as ConversationId;
		try {
			// Seed a REAL pending pi.generation task for the root conversation
			// WITHOUT ever resuming the scheduler, then close. The next boot's
			// `inspect` will see this as an unfinished generation.
			const storage = await openNodeSqliteStorage(storagePath);
			rawHarness = await Harness.open(
				storage,
				{
					registry: createRegistry(),
					// An empty Models object: the scheduler never runs while
					// this seed harness is open, so no model lookup happens.
					models: createModels(),
				},
				BACKGROUND_CONTEXT,
			);
			const root = await rawHarness.root(BACKGROUND_CONTEXT);
			rootId = root.id;
			await root.commit(async (tx) => {
				await tx.createTask(GenerationTask, {}, {
					ownership: { kind: "conversation" },
				});
			}, BACKGROUND_CONTEXT);
			// Inspect BEFORE close to confirm the seeded task is pending (the
			// scheduler never ran it).
			const inspection = await rawHarness.inspect(BACKGROUND_CONTEXT);
			const tasks = inspection.tasks.filter(
				(t) => t.record.kind === "pi.generation" && t.record.conversationId === rootId,
			);
			expect(tasks).toHaveLength(1);
			expect(tasks[0]!.state.kind).toBe("pending");
			await rawHarness.close(BACKGROUND_CONTEXT);
			rawHarness = undefined;
			// Plant the marker file under the stateDir layout boot expects
			// (`<stateDir>/core/inflight-requests`).
			const markerDir = join(bootDir, "state", "core", "inflight-requests");
			mkdirSync(markerDir, { recursive: true });
			await writeFile(
				join(markerDir, `${rootId}.json`),
				JSON.stringify({ conversationId: rootId, taskId: 1, at: Date.now() }),
			);
			// Boot sigrun normally: recover must find the marker + live task.
			const faux = fauxProvider({
				provider: "faux",
				models: [{ id: "m", contextWindow: 128_000 }],
			});
			faux.setResponses([fauxAssistantMessage("idle")]);
			const contributor: ProviderContributor = {
				name: "ext-faux",
				providers: [{ provider: faux.provider }],
			};
			const config = loadConfig({
				SIGRUN_DEFAULT_MODEL: "faux/m",
				SIGRUN_STORAGE_PATH: storagePath,
				SIGRUN_WORKSPACE_PATH: bootDir,
				SIGRUN_STATE_DIR: join(bootDir, "state"),
			});
			await writeFile(join(bootDir, "settings.json"), '{"namingModel": false}');
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			let opened: Awaited<ReturnType<typeof openHarness>> | undefined;
			try {
				opened = await openHarness(config, {
					identity: await seededIdentity(bootDir),
					extensions: [contributor],
					builtins: false,
					env: {},
					settingsDir: bootDir,
				});
				// The recovered root conversation is in leanRetries.
				expect(opened.leanRetries).toEqual([rootId]);
				// And the recovery was LOGGED (minor 9: the unsolicited log is
				// observable behavior and is pinned here).
				const leanLogs = logSpy.mock.calls.filter((args) =>
					typeof args[0] === "string" && args[0].startsWith("lean retry:"),
				);
				expect(leanLogs).toHaveLength(1);
				expect(String(leanLogs[0]![0])).toContain("1 conversation(s)");
			} finally {
				logSpy.mockRestore();
				if (opened !== undefined) {
					await opened.harness.close(BACKGROUND_CONTEXT);
				}
			}
		} finally {
			if (rawHarness !== undefined) {
				await rawHarness.close(BACKGROUND_CONTEXT);
			}
			await rm(bootDir, { recursive: true, force: true });
		}
	});

	test("a clean boot leaves leanRetries empty and emits no lean log", { timeout: 20_000 }, async () => {
		const bootDir = await mkdtemp(join(tmpdir(), "sigrun-lean-boot-"));
		try {
			const faux = fauxProvider({
				provider: "faux",
				models: [{ id: "m", contextWindow: 128_000 }],
			});
			faux.setResponses([fauxAssistantMessage("idle")]);
			const contributor: ProviderContributor = {
				name: "ext-faux",
				providers: [{ provider: faux.provider }],
			};
			const config = loadConfig({
				SIGRUN_DEFAULT_MODEL: "faux/m",
				SIGRUN_STORAGE_PATH: join(bootDir, "sigrun.db"),
				SIGRUN_WORKSPACE_PATH: bootDir,
				SIGRUN_STATE_DIR: join(bootDir, "state"),
			});
			await writeFile(join(bootDir, "settings.json"), '{"namingModel": false}');
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
			let opened: Awaited<ReturnType<typeof openHarness>> | undefined;
			try {
				opened = await openHarness(config, {
					identity: await seededIdentity(bootDir),
					extensions: [contributor],
					builtins: false,
					env: {},
					settingsDir: bootDir,
				});
				expect(opened.leanRetries).toEqual([]);
				const leanLogs = logSpy.mock.calls.filter((args) =>
					typeof args[0] === "string" && args[0].startsWith("lean retry:"),
				);
				expect(leanLogs).toHaveLength(0);
			} finally {
				logSpy.mockRestore();
				if (opened !== undefined) {
					await opened.harness.close(BACKGROUND_CONTEXT);
				}
			}
		} finally {
			await rm(bootDir, { recursive: true, force: true });
		}
	});
});
