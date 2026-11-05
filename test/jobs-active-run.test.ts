/**
 * Host job hooks (warden Task 3): `host.jobs.activeRun(conversationId)` —
 * whether a job fire is CURRENTLY running in one conversation, and the
 * job's effective owner for routing decisions (live person vs unattended
 * job).
 *
 * A run is held in `running` by queueing a faux response factory whose
 * promise the test resolves only when it wants the run to settle (the
 * queue is one-shot per call, so the run cannot finish early).
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
import type {
	AssistantMessage,
} from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { JobSpec } from "@sigrun/shared/jobs";
import { loadConfig } from "../src/config.js";
import type { SigrunHost } from "../src/extension.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { SeamHost } from "../src/harness/seam-host.js";
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

/** The host-jobs boot pattern; the faux handle is returned for gating. */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-jobs-active-run-"));
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
		name: "nightly-check",
		schedule: { at: "2099-01-01T00:00:00.000Z" },
		action: {
			kind: "prompt",
			prompt: "check the job state",
			conversation: "new",
		},
		...overrides,
	};
}

/** A gated response: the model call stays in flight until `release()`. */
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

/** Wait for the fired run to settle to a terminal outcome: the model
 * settles (waitForIdle), then the event bus delivers runSettled to the
 * jobs observer (drain). */
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

describe("host.jobs.activeRun", () => {
	test('a "new"-conversation fire is the active run of its conversation while running', async () => {
		const { opened, faux } = await bootServer();
		const host = channelHost(opened);
		const job = await opened.jobs.createApi(jobSpec(), "alice");
		const gate = holdRun(faux);

		const fire = await opened.jobs.runNow(job.id);
		expect(gate).toBeDefined();
		expect(fire).toMatchObject({ outcome: "running" });
		expect(fire.conversationId).toBeTypeOf("number");

		await expect(
			host.jobs.activeRun(fire.conversationId as ConversationId),
		).resolves.toEqual({ jobId: job.id, owner: "alice" });

		gate.release();
		await waitSettled(opened, job.id);
	});

	test("a fixed-conversation fire is the active run while running, and undefined after it settles", { timeout: 30_000 }, async () => {
		const { opened, faux } = await bootServer();
		const host = channelHost(opened);
		const id = await host.conversations.create({ owner: "alice" });
		const job = await opened.jobs.createApi(
			jobSpec({
				action: {
					kind: "prompt",
					prompt: "check the job state",
					conversation: id as unknown as number,
				},
			}),
			"alice",
		);
		const gate = holdRun(faux);

		const fire = await opened.jobs.runNow(job.id);
		expect(fire).toMatchObject({
			outcome: "running",
			conversationId: id as unknown as number,
		});
		await expect(host.jobs.activeRun(id)).resolves.toEqual({
			jobId: job.id,
			owner: "alice",
		});
		// The fire stamps jobId on the fixed conversation's SessionMeta —
		// the runSettled observer finds the run to settle BY this field.
		await expect(host.conversations.meta(id)).resolves.toMatchObject({
			jobId: job.id,
		});

		gate.release();
		await waitSettled(opened, job.id);
		await expect(host.jobs.activeRun(id)).resolves.toBeUndefined();
	});

	test("a conversation with no job run reads undefined", async () => {
		const { opened } = await bootServer();
		const host = channelHost(opened);
		const id = await host.conversations.create({ owner: "alice" });
		await expect(host.jobs.activeRun(id)).resolves.toBeUndefined();
	});

	test("an ownerless job reports the primary admin as owner", async () => {
		const { opened, faux } = await bootServer();
		const host = channelHost(opened);
		const job = await opened.jobs.createApi(jobSpec(), undefined);
		const gate = holdRun(faux);

		const fire = await opened.jobs.runNow(job.id);
		expect(fire.outcome).toBe("running");
		await expect(
			host.jobs.activeRun(fire.conversationId as ConversationId),
		).resolves.toEqual({ jobId: job.id, owner: "root-admin" });

		gate.release();
		await waitSettled(opened, job.id);
	});
});
