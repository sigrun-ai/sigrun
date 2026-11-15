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
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
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
	createLeanRetry,
	LEAN_RETRY_EXTENSION,
} from "../src/harness/lean-retry.js";

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
		let calledOrder: Array<"record" | "handler"> = [];
		const cid = 101 as ConversationId;
		const tid = 7 as TaskId;
		const extension = defineExtension({
			name: "fixture-record-order",
			hooks: [
				hook(GenerationTask, {
					beforeRequest() {
						calledOrder.push("handler");
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
		// Spy the record write order by reading the file via the handler.
		if (existsSync(join(dir, `${cid}.json`))) calledOrder.push("record");
		await handler({ messages: [] }, hookApi(cid, tid));
		expect(calledOrder).toEqual(["handler"]);
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
		const firstAt = readMarker(cid).at;
		// Bump the marker's at to a sentinel, then re-run the hook: a same-task
		// re-entry must leave the sentinel alone (only taskId re-stamps).
		await writeMarker(cid, tid, 999_999);
		await handlers.beforeRequest({ messages: [] }, hookApi(cid, tid));
		expect(readMarker(cid).at).toBe(999_999);
		void firstAt;
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

	test("the marker dir exists after boot-style construction (mkdirSync)", async () => {
		// The factory itself does not create the dir (boot owns that), but
		// the wrapper's write path must tolerate the dir being created
		// lazily — boot does `mkdirSync(dir, { recursive: true })` before
		// wrapping anything, so the file writes become plain file I/O.
		const lazyDir = join(dir, "lazy", "nested");
		const lean = createLeanRetry({ dir: lazyDir });
		// We don't expect the constructor to create it, but the first
		// record write must succeed under recursive dir creation.
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
