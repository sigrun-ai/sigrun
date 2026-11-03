/**
 * Host job hooks (A5): the extension-facing `jobs.get` projection and
 * `conversations.create({job})` over the same jobs service, conversation
 * op, and session-meta document the HTTP surfaces use.
 *
 * The job-state assertion renders through the REAL resolved agent and
 * committed session meta (not a fabricated PromptInput): host creation
 * must supply everything the A2 section needs on its next run.
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
} from "@earendil-works/pi-ai/providers/faux";
import type {
	ConversationId,
	DocumentReader,
	PromptInput,
} from "@earendil-works/pi-durable";
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
	readonly app: Awaited<ReturnType<typeof createServer>>;
	readonly aliceToken: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** The host-conversations boot pattern, with the fixture host as the caller. */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-host-jobs-"));
	const configDir = join(dir, "config");
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("answer")]);
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
	await identity.users.add({ user: "bob", admin: false, source: "cli" });
	const opened = await openHarness(config, {
		identity,
		extensions: [{ name: "ext-faux", providers: [{ provider: faux.provider }] }],
		extensionSpecifiers: [CHANNEL_SPECIFIER],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
	});
	const app = await createServer(opened, config);
	const { token: aliceToken } = await opened.identity.tokens.create(
		"alice-cli",
		"alice",
	);
	cleanups.push(async () => {
		await app.close().catch(() => {});
		await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	return { opened, app, aliceToken };
}

function channelHost(opened: OpenedHarness): SeamHost & SigrunHost {
	const host = opened.seamHosts.get("fixture-channel");
	if (host === undefined) throw new Error("fixture-channel host not loaded");
	return host as SeamHost & SigrunHost;
}

/** One valid api job, far enough in the future not to fire during the test. */
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

async function createAliceJob(opened: OpenedHarness): Promise<{ id: string }> {
	return await opened.jobs.createApi(jobSpec(), "alice");
}

/** Read the real resolved section using the real committed doc reader. */
async function renderJobState(
	opened: OpenedHarness,
	id: ConversationId,
): Promise<string | undefined> {
	const conversation = await opened.harness.conversation(id, BACKGROUND_CONTEXT);
	if (conversation === undefined) throw new Error(`conversation ${id} not found`);
	const agent = await conversation.agent(BACKGROUND_CONTEXT);
	const section = agent.sections.find((one) => one.key === "job-state");
	if (section === undefined) throw new Error("core job-state section not selected");
	const input: PromptInput = {
		conversationId: id,
		agent,
		env: undefined,
		shown: {},
		read: opened.harness as DocumentReader,
	};
	return await section.render(input, BACKGROUND_CONTEXT);
}

describe("host.jobs.get", () => {
	test("serves the live job projection and undefined for unknown or retired ids", async () => {
		const { opened } = await bootServer();
		const host = channelHost(opened);
		const created = await createAliceJob(opened);
		const wire = await opened.jobs.get(created.id);
		if (wire === undefined) throw new Error("created job not found");

		const info = await host.jobs.get(created.id);
		expect(info).toEqual({
			id: created.id,
			name: "nightly-check",
			owner: "alice",
			enabled: wire.enabled,
			state: wire.state,
		});
		expect(Object.keys(info ?? {})).toEqual([
			"id",
			"name",
			"owner",
			"enabled",
			"state",
		]);
		await expect(host.jobs.get("api:missing")).resolves.toBeUndefined();
		await opened.jobs.deleteApi(created.id, "alice");
		await expect(host.jobs.get(created.id)).resolves.toBeUndefined();
	});

	test("ownerless jobs expose the primary admin as their effective owner", async () => {
		const { opened } = await bootServer();
		const host = channelHost(opened);
		const created = await opened.jobs.createApi(jobSpec(), undefined);
		await expect(host.jobs.get(created.id)).resolves.toMatchObject({
			owner: "root-admin",
		});
		const id = await host.conversations.create({
			owner: "root-admin",
			job: created.id,
		});
		expect(await host.conversations.meta(id)).toMatchObject({
			owner: "root-admin",
			jobId: created.id,
		});
	});

	test("a disabled job reports enabled false and state disabled", async () => {
		const { opened } = await bootServer();
		const host = channelHost(opened);
		const created = await opened.jobs.createApi(
			jobSpec({ enabled: false }),
			"alice",
		);
		await expect(host.jobs.get(created.id)).resolves.toEqual({
			id: created.id,
			name: "nightly-check",
			owner: "alice",
			enabled: false,
			state: "disabled",
		});
	});
});

describe("host.conversations.create({job})", () => {
	test("stamps owner and jobId together, creates no run, and renders job state", async () => {
		const { opened } = await bootServer();
		const host = channelHost(opened);
		const job = await createAliceJob(opened);
		const before = await opened.jobs.get(job.id);
		const id = await host.conversations.create({ owner: "alice", job: job.id });

		const meta = await host.conversations.meta(id);
		expect(meta).toMatchObject({ owner: "alice", jobId: job.id });
		expect(meta.lastActivityAt).toEqual(expect.any(String));
		await expect(opened.jobs.runs(job.id, 20)).resolves.toEqual([]);
		expect((await opened.jobs.get(job.id))?.lastRun).toBe(before?.lastRun);

		const rendered = await renderJobState(opened, id);
		expect(rendered).toContain(
			`Job state: this conversation is a run of job "nightly-check" (${job.id}).`,
		);
		expect(rendered).toContain(`/alice/jobs/${encodeURIComponent(job.id)}`);
	});

	test("rejects a mismatched owner and an unknown job before creating anything", async () => {
		const { opened } = await bootServer();
		const host = channelHost(opened);
		const job = await createAliceJob(opened);
		const before = (await host.conversations.list()).length;
		for (const opts of [
			{ owner: "bob", job: job.id },
			{ job: "api:missing" },
		]) {
			await expect(host.conversations.create(opts)).rejects.toMatchObject({
				name: "ConversationOpError",
				body: { error: "invalid_field", field: "job" },
				status: 400,
			});
		}
		await expect(host.conversations.create({ job: job.id })).rejects.toMatchObject({
			body: { error: "invalid_field", field: "job" },
		});
		expect((await host.conversations.list()).length).toBe(before);
		await expect(opened.jobs.runs(job.id, 20)).resolves.toEqual([]);
	});

	test("rejects a retired job", async () => {
		const { opened } = await bootServer();
		const host = channelHost(opened);
		const job = await createAliceJob(opened);
		await opened.jobs.deleteApi(job.id, "alice");
		await expect(
			host.conversations.create({ owner: "alice", job: job.id }),
		).rejects.toMatchObject({
			name: "ConversationOpError",
			body: { error: "invalid_field", field: "job" },
		});
	});

	test("POST /v1/conversations never accepts a job body", async () => {
		const { app, aliceToken } = await bootServer();
		const response = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			headers: {
				authorization: `Bearer ${aliceToken}`,
				"content-type": "application/json",
			},
			payload: JSON.stringify({ job: "api:1" }),
		});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({ error: "invalid_body" });
	});
});
