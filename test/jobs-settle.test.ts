/**
 * Job run settlement: exact fire-key routing and the run conversation's
 * terminal `jobOutcome` marker.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { JobSpec } from "@sigrun/shared/jobs";
import { loadConfig } from "../src/config.js";
import type { SigrunHost } from "../src/extension.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { SeamHost } from "../src/harness/seam-host.js";
import { jobIdOfFireKey } from "../src/jobs/docs.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

const CHANNEL_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-channel", "index.js"),
).href;

interface TestServer {
	readonly opened: OpenedHarness;
	readonly faux: FauxProviderHandle;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
}, 120_000);

async function bootServer(options?: { readonly retryOff?: boolean }): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-jobs-settle-"));
	const configDir = join(dir, "config");
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "token",
		SIGRUN_TIMEZONE: "UTC",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: configDir,
	}, { server: {} } as Parameters<typeof loadConfig>[1]);
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const identity = await seededIdentity(dir, "root-admin");
	await identity.users.add({ user: "alice", admin: false, source: "cli" });
	const opened = await openHarness(config, {
		identity,
		extensions: [{ name: "ext-faux", providers: [{ provider: faux.provider }] }],
		extensionSpecifiers: [CHANNEL_SPECIFIER],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
		settings: {
			followUpMode: "all",
			...(options?.retryOff ? { retry: { enabled: false } } : {}),
		},
	});
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close().catch(() => {});
		await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	return { opened, faux };
}

function channelHost(opened: OpenedHarness): SeamHost & SigrunHost {
	const host = opened.seamHosts.get("fixture-channel");
	if (host === undefined) throw new Error("fixture-channel host not loaded");
	return host as SeamHost & SigrunHost;
}

function jobSpec(overrides?: Partial<JobSpec>): JobSpec {
	return {
		name: "acme-nightly-check",
		schedule: { at: "2099-01-01T00:00:00.000Z" },
		action: {
			kind: "prompt",
			prompt: "check the job state",
			conversation: "new",
		},
		...overrides,
	};
}

function holdRun(faux: FauxProviderHandle): { release: () => void } {
	let resolve!: (message: AssistantMessage) => void;
	const gate = new Promise<AssistantMessage>((res) => {
		resolve = res;
	});
	faux.setResponses([async () => await gate]);
	return {
		release: () => {
			resolve(fauxAssistantMessage("done"));
		},
	};
}

async function waitSettled(opened: OpenedHarness, jobId: string): Promise<void> {
	await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
	await opened.eventBus.drain(10_000, BACKGROUND_CONTEXT);
	for (let i = 0; i < 500; i += 1) {
		const job = await opened.jobs.get(jobId);
		if (job?.lastRun !== undefined && job.lastRun.outcome !== "running") return;
		await new Promise((res) => setTimeout(res, 20));
	}
	throw new Error(`run of ${jobId} never settled`);
}

describe("job run settlement", () => {
	test("jobIdOfFireKey keeps colons in job ids", () => {
		expect(jobIdOfFireKey("ext:acme:daily:1793955600000")).toBe("ext:acme:daily");
		expect(jobIdOfFireKey("ext:acme:daily:manual:1793955600000")).toBe("ext:acme:daily");
		expect(jobIdOfFireKey("api:0f3c…:12")).toBe("api:0f3c…");
		expect(jobIdOfFireKey("nocolon")).toBeUndefined();
		expect(jobIdOfFireKey("file:x:notanumber")).toBeUndefined();
	});

	test("a run-now fire into a fixed conversation settles", async () => {
		const { opened, faux } = await bootServer();
		const host = channelHost(opened);
		const id = await host.conversations.create({ owner: "alice" });
		const job = await opened.jobs.createApi(jobSpec({
			action: { kind: "prompt", prompt: "acme manual check", conversation: id as unknown as number },
		}), "alice");
		faux.setResponses([fauxAssistantMessage("manual done")]);

		const fire = await opened.jobs.runNow(job.id);
		expect(fire).toMatchObject({ outcome: "running", conversationId: id as unknown as number });
		await waitSettled(opened, job.id);
		expect((await opened.jobs.get(job.id))?.lastRun).toMatchObject({
			manual: true,
			outcome: "succeeded",
		});
	});

	test("a succeeded new-conversation run records jobOutcome succeeded", async () => {
		const { opened, faux } = await bootServer();
		const host = channelHost(opened);
		const job = await opened.jobs.createApi(jobSpec(), "alice");
		faux.setResponses([fauxAssistantMessage("done")]);
		const fire = await opened.jobs.runNow(job.id);
		if (fire.conversationId === undefined) throw new Error("new-conversation fire has no id");

		await waitSettled(opened, job.id);
		await expect(host.conversations.meta(fire.conversationId as ConversationId)).resolves.toMatchObject({
			jobId: job.id,
			jobOutcome: "succeeded",
		});
	});

	test("a failed run records jobOutcome failed", async () => {
		const { opened, faux } = await bootServer({ retryOff: true });
		const host = channelHost(opened);
		const job = await opened.jobs.createApi(jobSpec(), "alice");
		faux.setResponses([fauxAssistantMessage("boom", {
			stopReason: "error",
			errorMessage: "faux provider failure",
		})]);
		const fire = await opened.jobs.runNow(job.id);
		if (fire.conversationId === undefined) throw new Error("new-conversation fire has no id");

		await waitSettled(opened, job.id);
		expect((await opened.jobs.get(job.id))?.lastRun).toMatchObject({
			outcome: "failed",
			error: "model_error",
		});
		await expect(host.conversations.meta(fire.conversationId as ConversationId)).resolves.toMatchObject({
			jobId: job.id,
			jobOutcome: "failed",
		});
	});

	test("two jobs firing into one conversation settle their own runs", { timeout: 30_000 }, async () => {
		const { opened, faux } = await bootServer();
		const host = channelHost(opened);
		const id = await host.conversations.create({ owner: "alice" });
		const makeJob = async (name: string) => await opened.jobs.createApi(jobSpec({
			name,
			overlap: "queue",
			action: { kind: "prompt", prompt: `${name} check`, conversation: id as unknown as number },
		}), "alice");
		const a = await makeJob("acme-a");
		const b = await makeJob("acme-b");
		const gate = holdRun(faux);
		const conversation = await opened.harness.conversation(id, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new Error("fixed conversation not found");
		const userSubmission = await conversation.submit({
			type: "input",
			content: [{ type: "text", text: "hold the user run" }],
			requestId: "acme-user-hold",
		}, BACKGROUND_CONTEXT);
		expect(userSubmission).toBeDefined();
		await opened.jobs.runNow(a.id);
		await opened.jobs.runNow(b.id);
		faux.setResponses([
			fauxAssistantMessage("user done"),
			fauxAssistantMessage("job a done"),
			fauxAssistantMessage("job b done"),
		]);
		gate.release();

		await waitSettled(opened, a.id);
		await waitSettled(opened, b.id);
		expect((await opened.jobs.get(a.id))?.lastRun).toMatchObject({ outcome: "succeeded" });
		expect((await opened.jobs.get(b.id))?.lastRun).toMatchObject({ outcome: "succeeded" });
		await expect(host.conversations.meta(id)).resolves.not.toHaveProperty("jobOutcome");
	});

	test("a fixed-conversation fire never writes jobOutcome", async () => {
		const { opened, faux } = await bootServer();
		const host = channelHost(opened);
		const id = await host.conversations.create({ owner: "alice" });
		const job = await opened.jobs.createApi(jobSpec({
			action: { kind: "prompt", prompt: "acme fixed check", conversation: id as unknown as number },
		}), "alice");
		faux.setResponses([fauxAssistantMessage("fixed done")]);
		await opened.jobs.runNow(job.id);
		await waitSettled(opened, job.id);

		await expect(host.conversations.meta(id)).resolves.not.toHaveProperty("jobOutcome");
	});
});
