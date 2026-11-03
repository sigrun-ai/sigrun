/**
 * Jobs effective ownership (spec §6.5): a declared job with no live
 * owner belongs to the first stored admin at each use, without rewriting
 * its declaration. Its wire access and new-run conversation ownership
 * follow that user; an empty directory stays ownerless.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { AgentDoc } from "@earendil-works/pi-durable";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { JobSpec } from "@sigrun/shared/jobs";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import {
	effectiveOwner,
	primaryAdmin,
} from "../src/harness/identity/primary-admin.js";
import type {
	DirectoryUser,
	IdentityStores,
} from "../src/harness/identity/index.js";
import { readJob } from "../src/jobs/docs.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { unclaimedIdentity } from "./helpers/identity.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

function directoryUser(
	user: string,
	admin: boolean,
	createdAt: number,
): DirectoryUser {
	return { user, admin, source: "cli", createdAt };
}

const DIRECTORY: readonly DirectoryUser[] = [
	directoryUser("bob", false, 1),
	directoryUser("root-admin", true, 2),
	directoryUser("carol", true, 3),
];
const USER_TOOLS_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-user-tools", "index.js"),
).href;

function nightlyCheck(): JobSpec {
	return {
		name: "nightly-check",
		schedule: { every: "3600s" },
		action: { kind: "prompt", prompt: "say ok", conversation: "new" },
	};
}

async function call(
	app: FastifyInstance,
	method: "GET" | "POST",
	url: string,
	token?: string,
): Promise<{ status: number; json: any }> {
	const response = await app.inject({
		method,
		url,
		headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
	});
	return { status: response.statusCode, json: response.json() };
}

describe("primaryAdmin and effectiveOwner", () => {
	test("the first stored admin wins, regardless of directory position", () => {
		expect(primaryAdmin(DIRECTORY)?.user).toBe("root-admin");
		expect(primaryAdmin([DIRECTORY[0]!])).toBeUndefined();
	});

	test("live owners stay; missing owners resolve to the primary admin", () => {
		expect(effectiveOwner(DIRECTORY, "bob")).toBe("bob");
		expect(effectiveOwner(DIRECTORY, undefined)).toBe("root-admin");
		expect(effectiveOwner(DIRECTORY, "ghost")).toBe("root-admin");
		expect(effectiveOwner([], undefined)).toBeUndefined();
	});
});

describe("a declared job's effective owner", () => {
	test("the live admin owns the row and new run; bob cannot see the run", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-jobs-owner-"));
		await writeFile(
			join(dir, "settings.json"),
			`${JSON.stringify({ namingModel: false, jobs: [nightlyCheck()] }, null, "\t")}\n`,
		);
		const faux = fauxProvider({
			provider: "faux",
			models: [{ id: "m", contextWindow: 128_000 }],
		});
		faux.setResponses([fauxAssistantMessage("ok")]);
		const contributor: ProviderContributor = {
			name: "ext-faux",
			providers: [{ provider: faux.provider }],
		};
		const env = {
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_AUTH: "token",
			SIGRUN_TIMEZONE: "UTC",
		};
		const config = loadConfig(env);
		const identity = await unclaimedIdentity(dir);
		for (const [user, admin] of [
			["bob", false],
			["root-admin", true],
			["carol", true],
		] as const) {
			await identity.users.add({ user, admin, source: "cli" });
		}
		const opened = await openHarness(config, {
			extensions: [contributor],
			env,
			identity,
			settingsDir: dir,
			extensionSpecifiers: [USER_TOOLS_SPECIFIER],
		});
		const app = await createServer(opened, config);
		cleanups.push(async () => {
			await app.close().catch(() => {});
			await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
			await rm(dir, { recursive: true, force: true });
		});
		const mint = async (user: string): Promise<string> =>
			(await opened.identity.tokens.create("test", user)).token;
		const rootAdmin = await mint("root-admin");
		const bob = await mint("bob");
		const id = "file:nightly-check";

		const listed = await call(app, "GET", "/v1/jobs", rootAdmin);
		expect(listed.status).toBe(200);
		// Merged main loads the curator built-in, which declares its own job
		// (ext:curator:curator-tick) — assert OUR row, not the list length.
		const row = listed.json.jobs.find(
			(job: { id: string }) => job.id === id,
		);
		expect(row).toMatchObject({
			id,
			owner: "root-admin",
			access: "write",
		});
		const bobRow = await call(app, "GET", `/v1/jobs/${id}`, bob);
		// Pinned to the §5.9 hidden rule: a job whose effective owner moved
		// to an admin has no sharing, so bob's access is none — 404
		// `job_not_found`, not a read row (no 403 tell on any jobs route).
		expect(bobRow.status).toBe(404);
		expect(bobRow.json).toMatchObject({ error: "job_not_found" });

		const fired = await call(app, "POST", `/v1/jobs/${id}/run`, rootAdmin);
		expect(fired.status).toBe(200);
		expect(fired.json.outcome).toBe("running");
		const conversationId = fired.json.conversationId as number;
		const meta = await opened.harness.snapshot(
			SessionMetaDoc,
			conversationId as never,
			BACKGROUND_CONTEXT,
		);
		expect(meta).toMatchObject({
			jobId: id,
			owner: "root-admin",
			source: "cron",
		});
		const agent = await opened.harness.snapshot(
			AgentDoc,
			conversationId as never,
			BACKGROUND_CONTEXT,
		);
		expect(agent?.extensions).toMatchObject({
			add: expect.arrayContaining(["acme@root-admin"]),
		});

		const bobConversations = await call(app, "GET", "/v1/conversations", bob);
		expect(bobConversations.status).toBe(200);
		expect(
			(bobConversations.json.conversations as { id: number }[]).some(
				(row) => row.id === conversationId,
			),
		).toBe(false);

		await opened.identity.users.update("root-admin", { admin: false });
		const demoted = await opened.jobs.get(id);
		expect(demoted?.owner).toBe("carol");
		expect((await readJob(opened.harness, id, BACKGROUND_CONTEXT))?.owner).toBeUndefined();
		expect(JSON.parse(await readFile(join(dir, "users.json"), "utf8"))[0]).toMatchObject({
			user: "bob",
			admin: false,
		});
	});
});

describe("an empty directory", () => {
	test("the row and new run stay ownerless (single-operator behavior)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-jobs-owner-empty-"));
		await writeFile(
			join(dir, "settings.json"),
			`${JSON.stringify({ namingModel: false, jobs: [nightlyCheck()] }, null, "\t")}\n`,
		);
		const faux = fauxProvider({
			provider: "faux",
			models: [{ id: "m", contextWindow: 128_000 }],
		});
		faux.setResponses([fauxAssistantMessage("ok")]);
		const contributor: ProviderContributor = {
			name: "ext-faux",
			providers: [{ provider: faux.provider }],
		};
		const env = {
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_AUTH: "none",
			SIGRUN_API_TOKEN: "sgr_test_owner",
			SIGRUN_TIMEZONE: "UTC",
		};
		const config = loadConfig(env);
		const identity: IdentityStores = await unclaimedIdentity(dir);
		const opened = await openHarness(config, {
			extensions: [contributor],
			env,
			identity,
			settingsDir: dir,
		});
		const app = await createServer(opened, config);
		cleanups.push(async () => {
			await app.close().catch(() => {});
			await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
			await rm(dir, { recursive: true, force: true });
		});
		const id = "file:nightly-check";

		const service = "sgr_test_owner";
		const listed = await call(app, "GET", "/v1/jobs", service);
		expect(listed.status).toBe(200);
		expect(listed.json.jobs[0]).toMatchObject({ id, access: "write" });
		expect(listed.json.jobs[0].owner).toBeUndefined();
		const fired = await call(app, "POST", `/v1/jobs/${id}/run`, service);
		expect(fired.status).toBe(200);
		expect(fired.json.outcome).toBe("running");
		const meta = await opened.harness.snapshot(
			SessionMetaDoc,
			fired.json.conversationId as never,
			BACKGROUND_CONTEXT,
		);
		expect(meta?.owner).toBeUndefined();
	});
});
