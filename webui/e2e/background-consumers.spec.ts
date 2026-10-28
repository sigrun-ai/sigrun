/**
 * E2E harness background-model-consumer contract (release readiness 3 §2).
 *
 * These are integration specs for the harness's opt-in switches, driven
 * through the real submission API and durable transcript. Recording faux
 * response factories pin the shared queue order: foreground responses first,
 * then the deliberately scripted background response.
 */

import { expect, test } from "@playwright/test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { bootE2EServer, type E2EServer } from "./harness.js";

function recordingAnswer(calls: string[], label: string, text: string): FauxResponseStep {
	return () => {
		calls.push(label);
		return fauxAssistantMessage(text);
	};
}

async function submit(server: E2EServer, input: string): Promise<void> {
	const response = await server.app.inject({
		method: "POST",
		url: `/v1/conversations/${server.conversationId}/submissions?waitMs=5000`,
		payload: { input },
		headers: { "content-type": "application/json" },
	});
	expect(response.statusCode).toBe(202);
	expect(response.json().submission.status).toBe("done");
	await server.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
	await server.opened.autoNamer.idle();
}

async function compactionEntries(server: E2EServer): Promise<EntryRecord[]> {
	const conversation = await server.opened.harness.conversation(
		server.conversationId as ConversationId,
		BACKGROUND_CONTEXT,
	);
	expect(conversation).toBeDefined();
	const page = await conversation!.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	return page.items.filter((entry) => entry.kind === "pi.compaction");
}

function textOf(entry: EntryRecord): string {
	return (entry.model ?? [])
		.flatMap((message: Message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content.map((block) => (block.type === "text" ? block.text : "")),
		)
		.join("");
}

test("default boot performs no background model calls after a foreground turn", async () => {
	const calls: string[] = [];
	const server = await bootE2EServer({
		responses: [
			recordingAnswer(calls, "foreground-1", "foreground answer"),
			recordingAnswer(calls, "unexpected-background", "must stay queued"),
		],
	});
	try {
		await submit(server, "hello");
		expect(calls).toEqual(["foreground-1"]);
		expect(await compactionEntries(server)).toEqual([]);
	} finally {
		await server.cleanup();
	}
});

test("autoNaming opt-in consumes queue position two and names the conversation", async () => {
	const calls: string[] = [];
	const server = await bootE2EServer({
		autoNaming: true,
		responses: [
			// Queue #1 is the submitted turn; #2 is deliberately the auto-name call.
			recordingAnswer(calls, "foreground-1", "foreground answer"),
			recordingAnswer(calls, "auto-name-2", "Deliberate E2E title"),
		],
	});
	try {
		await submit(server, "name this chat");
		expect(calls).toEqual(["foreground-1", "auto-name-2"]);
		const response = await server.app.inject({
			method: "GET",
			url: `/v1/conversations/${server.conversationId}/meta`,
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().autoName).toBe("Deliberate E2E title");
	} finally {
		await server.cleanup();
	}
});

test("compaction opt-in consumes the deliberately scripted summary position", async () => {
	const calls: string[] = [];
	const server = await bootE2EServer({
		compaction: true,
		settings: {
			compaction: {
				reserveTokens: 127_400,
				keepRecentTokens: 1,
				backgroundTokens: 0,
			},
		},
		responses: [
			// Queue #1 answers turn one. Turn two compacts first (#2), then retries
			// the foreground generation (#3): the queue cannot shift unnoticed.
			recordingAnswer(calls, "foreground-1", "first answer"),
			recordingAnswer(calls, "compaction-summary-2", "deliberate compacted summary"),
			recordingAnswer(calls, "foreground-3", "second answer"),
		],
	});
	try {
		await submit(server, `first question ${"filler ".repeat(180)}`);
		await submit(server, `second question ${"context ".repeat(160)}`);
		expect(calls).toEqual(["foreground-1", "compaction-summary-2", "foreground-3"]);
		const compacted = await compactionEntries(server);
		expect(compacted).toHaveLength(1);
		expect(textOf(compacted[0]!)).toContain("deliberate compacted summary");
	} finally {
		await server.cleanup();
	}
});

for (const options of [
	{
		autoNaming: true,
		settingsFile: { namingModel: false },
	},
	{
		compaction: true,
		settingsFile: { server: { compaction: { enabled: false } } },
	},
] as const) {
	test(`contradictory options fail fast: ${JSON.stringify(options)}`, async () => {
		await expect(bootE2EServer(options)).rejects.toThrow(/contradict/);
	});
}
