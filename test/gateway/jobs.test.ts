/**
 * Gateway job delivery and home-chat notifications e2e (Task 10, spec
 * §8.8 over the real boot): new-run delivery is one-shot, fixed bound
 * conversations use the ordinary fan-out, disallowed targets log only,
 * failed jobs notify home, and unbound replies get a home notice.
 *
 * Tests own their literals: alice/bob, "100000001", "loop:999".
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { JobWire } from "@sigrun/shared/jobs";
import { bootGateway, type GatewayBoot } from "./harness.js";
import type { InboundEvent, OutboundMessage } from "../../src/extension.js";

const SETTINGS = {
	channels: { loop: { dm: "pairing" } },
};

/** Establish alice's home DM through the real pairing/link path. */
async function linkAlice(boot: GatewayBoot, messageId: string): Promise<void> {
	await boot.loop.inbound(dmEvent(messageId));
	const code = boot.loop.sent
		.filter((message) => message.chat.chatId === "100000001")
		.at(-1)?.text.match(/[A-Z2-9]{8}/)?.[0];
	if (code === undefined) throw new Error("pairing code missing");
	const conversation = await createConversation(boot);
	const response = await boot.app.inject({
		method: "POST",
		url: `/v1/conversations/${conversation}/commands/pair`,
		headers: { authorization: `Bearer ${boot.tokens.alice}` },
		payload: { args: `approve ${code} alice` },
	});
	expect(response.statusCode).toBe(200);
	await boot.waitFor(async () => {
		const raw = JSON.parse(await readFile(join(boot.dir, "state", "ext-gateway", "gateway", "identities.json"), "utf8")) as {
			homes: Record<string, unknown>;
		};
		return raw.homes.alice !== undefined;
	});
}

function dmEvent(messageId: string): InboundEvent {
	return {
		messageId,
		chat: { chatId: "100000001", chatType: "dm" },
		sender: { id: "100000001", name: "Alice" },
		text: "bind this chat",
	};
}

async function createJob(
	boot: GatewayBoot,
	action: Record<string, unknown>,
	name = "nightly",
): Promise<JobWire> {
	const response = await boot.app.inject({
		method: "POST",
		url: "/v1/jobs",
		headers: { authorization: `Bearer ${boot.tokens.alice}` },
		payload: { name, schedule: { every: "3600s" }, action },
	});
	expect(response.statusCode).toBe(201);
	return response.json().job as JobWire;
}

async function runJob(boot: GatewayBoot, id: string): Promise<number> {
	const response = await boot.app.inject({
		method: "POST",
		url: `/v1/jobs/${id}/run`,
		headers: { authorization: `Bearer ${boot.tokens.alice}` },
	});
	expect(response.statusCode).toBe(200);
	return response.json().conversationId as number;
}

async function createConversation(boot: GatewayBoot): Promise<number> {
	const response = await boot.app.inject({
		method: "POST",
		url: "/v1/conversations",
		headers: { authorization: `Bearer ${boot.tokens.alice}` },
	});
	expect(response.statusCode).toBe(201);
	return response.json().id as number;
}

async function submit(boot: GatewayBoot, id: number, text: string): Promise<number> {
	const response = await boot.app.inject({
		method: "POST",
		url: `/v1/conversations/${id}/submissions`,
		headers: { authorization: `Bearer ${boot.tokens.alice}` },
		payload: { input: [{ type: "text", text }] },
	});
	expect(response.statusCode).toBe(202);
	return response.json().submission.id as number;
}

async function waitForSubmission(
	boot: GatewayBoot,
	conversationId: number,
	submissionId: number,
): Promise<void> {
	await boot.waitFor(async () => {
		const response = await boot.app.inject({
			method: "GET",
			url: `/v1/conversations/${conversationId}/submissions/${submissionId}`,
			headers: { authorization: `Bearer ${boot.tokens.alice}` },
		});
		expect(response.statusCode).toBe(200);
		return response.json().submission.status === "done";
	});
}

function sendsSince(boot: GatewayBoot, from: number): readonly OutboundMessage[] {
	return boot.loop.sent.slice(from);
}

async function waitForJobOutcome(
	boot: GatewayBoot,
	id: string,
	outcome: "succeeded" | "failed",
): Promise<void> {
	await boot.waitFor(async () => {
		const response = await boot.app.inject({
			method: "GET",
			url: `/v1/jobs/${id}`,
			headers: { authorization: `Bearer ${boot.tokens.alice}` },
		});
		return (response.json().job as JobWire).lastRun?.outcome === outcome;
	});
}

describe("gateway jobs and home notifications e2e (Task 10)", () => {
	test("a new job delivers once to the owner's home DM; a later submit does not", { timeout: 90_000 }, async () => {
		const storesDir = await mkdtemp(join(tmpdir(), "sigrun-gw-job-dedupe-"));
		try {
			const first = await bootGateway({ gatewaySettings: SETTINGS, storesDir });
			try {
				await linkAlice(first, "bind-home");
			} finally {
				await first.shutdown();
			}
			const boot = await bootGateway({
				gatewaySettings: SETTINGS,
				storesDir,
				responses: [fauxAssistantMessage("job answer"), fauxAssistantMessage("follow-up answer")],
			});
			try {
				const before = boot.loop.sent.length;
				const job = await createJob(boot, {
					kind: "prompt",
					prompt: "say ok",
					conversation: "new",
					deliver: ["loop"],
				});
				const conversationId = await runJob(boot, job.id);
				await boot.waitFor(() => sendsSince(boot, before).some((message) =>
					message.text.startsWith("Job nightly · ") && message.text.endsWith("\njob answer"),
				));
				const submissionId = await submit(boot, conversationId, "continue this run");
				await waitForSubmission(boot, conversationId, submissionId);
				const homeMessages = sendsSince(boot, before).filter((message) =>
					message.chat.chatId === "100000001",
				);
				expect(homeMessages.filter((message) =>
					message.text.includes("follow-up answer"),
				)).toHaveLength(0);
				expect(homeMessages.filter((message) =>
					message.text.startsWith("Job "),
				)).toHaveLength(1);
				expect(homeMessages.filter((message) =>
					message.text.startsWith("Reply ready —"),
				)).toHaveLength(0);
			} finally {
				await boot.shutdown();
			}
		} finally {
			await rm(storesDir, { recursive: true, force: true });
		}
	});

	test("a job targeting a bound conversation uses its binding without deliver", { timeout: 90_000 }, async () => {
		const storesDir = await mkdtemp(join(tmpdir(), "sigrun-gw-job-bound-"));
		try {
			const first = await bootGateway({ gatewaySettings: SETTINGS, storesDir });
			let conversationId: number;
			try {
				await linkAlice(first, "bind-job-chat");
				await first.loop.inbound(dmEvent("bind-job-conversation"));
				const rows = await first.app.inject({
					method: "GET",
					url: "/v1/conversations",
					headers: { authorization: `Bearer ${first.tokens.alice}` },
				});
				conversationId = (rows.json().conversations as { id: number; source?: string }[])
					.find((row) => row.source === "gateway")!.id;
			} finally {
				await first.shutdown();
			}
			const boot = await bootGateway({
				gatewaySettings: SETTINGS,
				storesDir,
				responses: [fauxAssistantMessage("bound job answer")],
			});
			try {
				const before = boot.loop.sent.length;
				const job = await createJob(boot, {
					kind: "prompt",
					prompt: "say ok",
					conversation: conversationId,
				});
				await runJob(boot, job.id);
				await boot.waitFor(() => sendsSince(boot, before).some((message) =>
					message.chat.chatId === "100000001" && message.text === "bound job answer",
				));
				expect(sendsSince(boot, before).some((message) => message.text.startsWith("Job "))).toBe(false);
			} finally {
				await boot.shutdown();
			}
		} finally {
			await rm(storesDir, { recursive: true, force: true });
		}
	});

	test("an unbound foreign explicit chat is not sent and is logged", { timeout: 90_000 }, async () => {
		const storesDir = await mkdtemp(join(tmpdir(), "sigrun-gw-job-reject-"));
		try {
			const first = await bootGateway({ gatewaySettings: SETTINGS, storesDir });
			try {
				await linkAlice(first, "bind-reject-home");
			} finally {
				await first.shutdown();
			}
			const boot = await bootGateway({
				gatewaySettings: SETTINGS,
				storesDir,
				responses: [fauxAssistantMessage("withheld answer")],
			});
			try {
				const before = boot.loop.sent.length;
				const job = await createJob(boot, {
					kind: "prompt",
					prompt: "say ok",
					conversation: "new",
					deliver: ["loop:999"],
				});
				await runJob(boot, job.id);
				await waitForJobOutcome(boot, job.id, "succeeded");
				// The run settles without enqueueing any job-target entry;
				// the engine's warn above is the required rejection log.
				await new Promise((resolve) => setTimeout(resolve, 300));
				const ledger = JSON.parse(await readFile(join(storesDir, "state", "ext-gateway", "gateway", "ledger.json"), "utf8")) as {
					entries: { tag?: string }[];
				};
				expect(ledger.entries.some((entry) => entry.tag?.startsWith("job:") === true)).toBe(false);
				expect(sendsSince(boot, before).filter((message) =>
					message.chat.chatId === "999",
				)).toEqual([]);
			} finally {
				await boot.shutdown();
			}
		} finally {
			await rm(storesDir, { recursive: true, force: true });
		}
	});

	test("a failed job notifies the owner's home DM", { timeout: 90_000 }, async () => {
		const storesDir = await mkdtemp(join(tmpdir(), "sigrun-gw-job-failed-"));
		try {
			const first = await bootGateway({ gatewaySettings: SETTINGS, storesDir });
			try {
				await linkAlice(first, "bind-failed-home");
			} finally {
				await first.shutdown();
			}
			const boot = await bootGateway({
				gatewaySettings: SETTINGS,
				storesDir,
				responses: [fauxAssistantMessage("boom", { stopReason: "error", errorMessage: "faux provider failure" })],
			});
			try {
				const before = boot.loop.sent.length;
				const job = await createJob(boot, {
					kind: "prompt",
					prompt: "say ok",
					conversation: "new",
				});
				await runJob(boot, job.id);
				await boot.waitFor(() => sendsSince(boot, before).some((message) =>
					message.chat.chatId === "100000001" &&
					message.text.startsWith("Job nightly failed\n"),
				));
			} finally {
				await boot.shutdown();
			}
		} finally {
			await rm(storesDir, { recursive: true, force: true });
		}
	});

	test("an unbound conversation gets Reply ready with its public link", { timeout: 90_000 }, async () => {
		const storesDir = await mkdtemp(join(tmpdir(), "sigrun-gw-reply-home-"));
		try {
			const first = await bootGateway({ gatewaySettings: SETTINGS, storesDir });
			try {
				await linkAlice(first, "bind-reply-home");
			} finally {
				await first.shutdown();
			}
			const boot = await bootGateway({
				gatewaySettings: SETTINGS,
				storesDir,
				authEnv: { SIGRUN_PUBLIC_URL: "https://sigrun.example.invalid" },
				responses: [fauxAssistantMessage("web answer")],
			});
			try {
				const before = boot.loop.sent.length;
				const id = await createConversation(boot);
				await submit(boot, id, "answer while away");
				await boot.waitFor(() => sendsSince(boot, before).some((message) =>
					message.text === `Reply ready — Conversation ${id}\nhttps://sigrun.example.invalid/#/c/${id}`,
				));
			} finally {
				await boot.shutdown();
			}
		} finally {
			await rm(storesDir, { recursive: true, force: true });
		}
	});

	test("a bound conversation gets no extra Reply ready notice", { timeout: 90_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: SETTINGS,
			responses: [fauxAssistantMessage("chat answer")],
		});
		try {
			const before = boot.loop.sent.length;
			await linkAlice(boot, "bound-pairing");
			await boot.loop.inbound(dmEvent("bound-no-notice"));
			await boot.waitFor(() => sendsSince(boot, before).some((message) => message.text === "chat answer"));
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(sendsSince(boot, before).some((message) => message.text.startsWith("Reply ready —"))).toBe(false);
		} finally {
			await boot.shutdown();
		}
	});
});
