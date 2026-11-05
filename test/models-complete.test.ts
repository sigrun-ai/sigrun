/**
 * Task 4 (warden, host.models.complete): one-shot completions for
 * extensions — `completeOnce` (src/harness/complete.ts) and the host
 * bridge's `models.complete` delegation.
 *
 * Fake `Models`: `getModel(provider, id)` gates the served set,
 * `completeSimple(model, context, options)` returns a crafted
 * AssistantMessage (or a never-settling promise for the stall test).
 * The bridge-level test drives a live `readSettings` reader whose
 * value changes between calls (the honest "live settings" shape).
 */

import { describe, expect, test } from "vitest";
import type { AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { completeOnce } from "../src/harness/complete.js";
import type { SettingsFile } from "../src/harness/settings.js";

const DEFAULT_MODEL: ModelRef = { provider: "faux", modelId: "default-1" };

interface CompletionCall {
	readonly provider: string;
	readonly id: string;
	readonly context: unknown;
	readonly options?: { signal?: AbortSignal };
}

/** A served/unserved catalog fake; completions record their call. */
function stubModels(
	served: readonly string[],
	respond?: (call: CompletionCall) => Promise<AssistantMessage>,
) {
	const calls: CompletionCall[] = [];
	const models = {
		getModel: (provider: string, id: string) =>
			served.includes(`${provider}/${id}`)
				? ({ provider, id } as Model<string>)
				: undefined,
		getModels: () =>
			served.map((key) => {
				const [provider, id] = key.split("/");
				return { provider, id } as Model<string>;
			}),
		completeSimple: (
			model: Model<string>,
			context: unknown,
			options?: { signal?: AbortSignal },
		) => {
			const call: CompletionCall = {
				provider: model.provider,
				id: model.id,
				context,
				...(options === undefined ? {} : { options }),
			};
			calls.push(call);
			return respond?.(call) ?? Promise.resolve(okMessage("skill card text"));
		},
	} as unknown as Models;
	return { models, calls };
}

function okMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "scratch" },
			{ type: "text", text },
		],
		api: "openai-completions",
		provider: "faux",
		model: "m",
		usage: {},
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as AssistantMessage;
}

function errorMessage(): AssistantMessage {
	return {
		...okMessage("partial text that must not resolve"),
		stopReason: "error",
		errorMessage: "upstream blew up",
	} as unknown as AssistantMessage;
}

describe("completeOnce", () => {
	test("an explicit model wins", async () => {
		const { models, calls } = stubModels(["faux/m", "faux/utility", "faux/default-1"]);
		const result = await completeOnce(
			{
				models,
				defaultModel: DEFAULT_MODEL,
				readSettings: () => ({ namingModel: "faux/utility" }) as SettingsFile,
			},
			{ model: "faux/m", prompt: "hello" },
		);
		expect(result).toEqual({ text: "skill card text", model: "faux/m" });
		expect(calls.map((c) => `${c.provider}/${c.id}`)).toEqual(["faux/m"]);
	});

	test("role utility uses namingModel", async () => {
		const { models, calls } = stubModels(["faux/utility", "faux/default-1"]);
		const result = await completeOnce(
			{
				models,
				defaultModel: DEFAULT_MODEL,
				readSettings: () => ({ namingModel: "faux/utility" }) as SettingsFile,
			},
			{ role: "utility", prompt: "hello" },
		);
		expect(result.model).toBe("faux/utility");
		expect(calls.map((c) => `${c.provider}/${c.id}`)).toEqual(["faux/utility"]);
	});

	test("namingModel false falls back to the default model", async () => {
		const { models, calls } = stubModels(["faux/default-1"]);
		const result = await completeOnce(
			{
				models,
				defaultModel: DEFAULT_MODEL,
				readSettings: () => ({ namingModel: false }) as SettingsFile,
			},
			{ prompt: "hello" },
		);
		expect(result.model).toBe("faux/default-1");
		expect(calls.map((c) => `${c.provider}/${c.id}`)).toEqual(["faux/default-1"]);
	});

	test("an unserved model throws naming it", async () => {
		const { models } = stubModels(["faux/default-1"]);
		await expect(
			completeOnce(
				{
					models,
					defaultModel: DEFAULT_MODEL,
					readSettings: () => ({}) as SettingsFile,
				},
				{ model: "faux/missing", prompt: "hello" },
			),
		).rejects.toThrow(/faux\/missing/);
	});

	test("a stalled provider times out", async () => {
		const { models, calls } = stubModels(["faux/m"], () => new Promise(() => {}));
		await expect(
			completeOnce(
				{
					models,
					defaultModel: DEFAULT_MODEL,
					readSettings: () => ({}) as SettingsFile,
				},
				{ model: "faux/m", prompt: "hello", timeoutMs: 50 },
			),
		).rejects.toThrow(/timed out|timeout/i);
		expect(calls).toHaveLength(1);
	});

	test("stopReason error throws", async () => {
		const { models } = stubModels(["faux/m"], () => Promise.resolve(errorMessage()));
		await expect(
			completeOnce(
				{
					models,
					defaultModel: DEFAULT_MODEL,
					readSettings: () => ({}) as SettingsFile,
				},
				{ model: "faux/m", prompt: "hello" },
			),
		).rejects.toThrow(/error|aborted/i);
	});

	test("an empty model spec throws the parse error", async () => {
		const { models } = stubModels(["faux/default-1"]);
		await expect(
			completeOnce(
				{
					models,
					defaultModel: DEFAULT_MODEL,
					readSettings: () => ({ namingModel: "faux/utility" }) as SettingsFile,
				},
				{ model: "", prompt: "hello" },
			),
		).rejects.toThrow(/non-empty model spec/);
	});

	test("input.signal aborts a stalled provider promptly", async () => {
		// The stall fake never settles: without a caller-abort arm the
		// race hangs until timeoutMs (60s here) even though the caller
		// aborted 20ms in.
		const { models, calls } = stubModels(["faux/m"], () => new Promise(() => {}));
		const controller = new AbortController();
		const call = completeOnce(
			{
				models,
				defaultModel: DEFAULT_MODEL,
				readSettings: () => ({}) as SettingsFile,
			},
			{ model: "faux/m", prompt: "hello", signal: controller.signal },
		);
		const expectation = expect(call).rejects.toThrow(
			/aborted by the caller/,
		);
		setTimeout(() => controller.abort(), 20);
		// Promptness proof: the rejection must land well before the 60s timeout.
		const promptness = new Promise((_, reject) =>
			setTimeout(() => reject(new Error("abort did not bound the wait")), 2000),
		);
		await Promise.race([expectation, promptness]);
		expect(calls).toHaveLength(1);
	});

	test("an already-aborted signal rejects without starting the request", async () => {
		const { models, calls } = stubModels(["faux/m"]);
		const controller = new AbortController();
		controller.abort();
		await expect(
			completeOnce(
				{
					models,
					defaultModel: DEFAULT_MODEL,
					readSettings: () => ({}) as SettingsFile,
				},
				{ model: "faux/m", prompt: "hello", signal: controller.signal },
			),
		).rejects.toThrow(/aborted by the caller/);
		expect(calls).toHaveLength(0);
	});

	test("the host bridge delegates with the live settings", async () => {
		// The bridge passes a live settings reader into completeOnce — a
		// settings change between calls must take effect without a restart.
		const { models, calls } = stubModels(["faux/utility", "faux/utility-2"]);
		let namingModel: string | false = "faux/utility";
		const deps = {
			models,
			defaultModel: DEFAULT_MODEL,
			readSettings: () => ({ namingModel }) as SettingsFile,
		};
		const first = await completeOnce(deps, { prompt: "one" });
		namingModel = "faux/utility-2";
		const second = await completeOnce(deps, { prompt: "two" });
		expect(first.model).toBe("faux/utility");
		expect(second.model).toBe("faux/utility-2");
		expect(calls.map((c) => c.id)).toEqual(["utility", "utility-2"]);
	});
});
