/**
 * Jobs Task 4 (spec §8.4 + §5.9): the `/v1/jobs` HTTP surface — the
 * route half over Task 3's JobsService.
 *
 * Pinned here:
 * - the CRUD round trip as alice (create 201 → list/get → PATCH bumps
 *   version + a `changedBy:"alice"` revision → DELETE 204 → 404, with
 *   the history routes still answering for the RETIRED job until
 *   retention trims it);
 * - the §5.9 access rule: bob (no share) gets 404 `job_not_found` on
 *   every `:id` route and absence from his list; after a
 *   household-`read` share he reads (200 / list / runs / revisions) but
 *   every write route is 403;
 * - declared jobs are immutable: `file:` ids PATCH/DELETE → 409
 *   `job_declared`;
 * - POST validation: `validateJobSpec` rejections → 400
 *   `{error:"invalid_field", field}` (the same vocabulary PATCH serves
 *   for the MERGED spec);
 * - run-now → `{outcome:"running", conversationId}` and the run lists
 *   first with `manual:true` at the job's current `version`;
 * - the runs `limit` grammar: default 20, non-positive/non-integer →
 *   400 `invalid_field limit`, above `jobHistory.runs` clamped.
 *
 * Hermetic pattern (sharing.test.ts): token method (alice/bob minted),
 * faux provider, tmp workspace, `app.inject()`.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { JobSpec } from "@sigrun/shared/jobs";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { jobStateDir, removeJobState } from "../src/jobs/state-dir.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

// Lifecycle cases use the real removal by default. Individual failure cases
// reject one call to pin the reset (surface) versus delete (best-effort) policy.
// The mock wraps BOTH the removal and the shared warn helper (one module
// namespace) so the wrapper in src/jobs/index.ts observes the injected
// failure. This mock is module-level for this FILE only — vitest module
// mocks are per test module, so nothing leaks into sibling suites.
vi.mock("../src/jobs/state-dir.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/jobs/state-dir.js")>();
	return {
		...actual,
		removeJobState: vi.fn(actual.removeJobState),
		warnJobStateRemoval: vi.fn(actual.warnJobStateRemoval),
	};
});

interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	dir: string;
	alice: string;
	bob: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot one hermetic CLAIMED server under the token method. */
async function bootServer(options?: {
	/** Settings-file contents, written BEFORE boot (the `file:` job source). */
	readonly settings?: Record<string, unknown>;
	readonly extensionSpecifiers?: readonly string[];
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-jobs-api-"));
	if (options?.settings !== undefined) {
		await writeFile(
			join(dir, "settings.json"),
			`${JSON.stringify(options.settings, null, "\t")}\n`,
		);
	}
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
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_AUTH: "token",
		SIGRUN_TIMEZONE: "UTC",
	};
	const config = loadConfig(env);
	const identity = await seededIdentity(dir);
	await identity.users.add({ user: "alice", admin: false, source: "cli" });
	await identity.users.add({ user: "bob", admin: false, source: "cli" });
	const opened = await openHarness(config, {
		extensions: [contributor],
		...(options?.extensionSpecifiers === undefined
			? {}
			: { extensionSpecifiers: options.extensionSpecifiers }),
		env,
		identity,
		settingsDir: dir,
	});
	const app = await createServer(opened, config);
	const mint = async (user: string): Promise<string> =>
		(await opened.identity.tokens.create("test", user)).token;
	cleanups.push(async () => {
		await app.close().catch(() => {});
		await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, dir, alice: await mint("alice"), bob: await mint("bob") };
}

function statePath(dir: string, owner: string, jobId: string): string {
	return jobStateDir(join(dir, "data", "users", owner, "jobs"), jobId);
}

async function seedState(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
	await writeFile(join(path, "notes.json"), "{}");
}

/** One injected request with auth (+ JSON content type for bodies). */
async function call(
	app: FastifyInstance,
	method: "GET" | "POST" | "PATCH" | "DELETE",
	url: string,
	token?: string,
	body?: unknown,
): Promise<{ status: number; json: any }> {
	const response = await app.inject({
		method,
		url,
		...(body === undefined
			? {}
			: { payload: JSON.stringify(body) }),
		headers: {
			...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
	});
	let json: any = undefined;
	try {
		json = response.json();
	} catch {
		json = undefined;
	}
	return { status: response.statusCode, json };
}

/** A valid prompt spec (the shared body of the create calls). */
function promptSpec(overrides?: Partial<JobSpec>): JobSpec {
	return {
		name: "nightly",
		schedule: { every: "3600s" },
		action: { kind: "prompt", prompt: "say ok", conversation: "new" },
		...overrides,
	};
}

describe("POST/GET/PATCH/DELETE /v1/jobs — the CRUD round trip as alice", () => {
	test("create → list → get → patch (revision changedBy alice) → delete → 404, history still answers", async () => {
		const { app, alice } = await bootServer();
		const created = await call(app, "POST", "/v1/jobs", alice, promptSpec());
		expect(created.status).toBe(201);
		const job = created.json.job;
		expect(job.id).toMatch(/^api:/);
		expect(job.source).toBe("api");
		expect(job.owner).toBe("alice");
		expect(job.enabled).toBe(true);
		expect(job.version).toBe(1);
		expect(job.access).toBe("write");

		const listed = await call(app, "GET", "/v1/jobs", alice);
		expect(listed.status).toBe(200);
		const row = listed.json.jobs.find((one: any) => one.id === job.id);
		expect(row).toBeDefined();
		expect(row.access).toBe("write");

		const got = await call(app, "GET", `/v1/jobs/${job.id}`, alice);
		expect(got.status).toBe(200);
		expect(got.json.job.id).toBe(job.id);

		const patched = await call(
			app,
			"PATCH",
			`/v1/jobs/${job.id}`,
			alice,
			promptSpec({ action: { kind: "prompt", prompt: "say tock", conversation: "new" } }),
		);
		expect(patched.status).toBe(200);
		expect(patched.json.job.version).toBe(2);

		const revisions = await call(
			app,
			"GET",
			`/v1/jobs/${job.id}/revisions`,
			alice,
		);
		expect(revisions.status).toBe(200);
		const revs = revisions.json.revisions;
		expect(revs[0].version).toBe(2);
		expect(revs[0].changedBy).toBe("alice");
		expect(revs[1].version).toBe(1);

		const deleted = await call(app, "DELETE", `/v1/jobs/${job.id}`, alice);
		expect(deleted.status).toBe(204);
		expect(await call(app, "GET", `/v1/jobs/${job.id}`, alice)).toMatchObject({
			status: 404,
			json: { error: "job_not_found" },
		});
		// Run-now, like PATCH/DELETE, requires a LIVE record: a retired job
		// (revision-resolvable for the history routes) 404s, never the
		// fire's blocked-200 (fix round 1).
		expect(await call(app, "POST", `/v1/jobs/${job.id}/run`, alice)).toMatchObject({
			status: 404,
			json: { error: "job_not_found" },
		});
		// Retired jobs keep answering the history routes until retention
		// trims them (spec §8.4) — with read access over the newest
		// revision's owner/sharing.
		expect(
			(await call(app, "GET", `/v1/jobs/${job.id}/runs`, alice)).status,
		).toBe(200);
		expect(
			(await call(app, "GET", `/v1/jobs/${job.id}/revisions`, alice)).status,
		).toBe(200);
	});

	test("create with a description serves it on the wire and in the revision", async () => {
		const { app, alice } = await bootServer();
		const created = await call(
			app,
			"POST",
			"/v1/jobs",
			alice,
			promptSpec({ description: "acme digest" }),
		);
		expect(created.status).toBe(201);
		expect(created.json.job.description).toBe("acme digest");

		const revisions = await call(
			app,
			"GET",
			`/v1/jobs/${created.json.job.id}/revisions`,
			alice,
		);
		expect(revisions.status).toBe(200);
		expect(revisions.json.revisions[0].spec.description).toBe("acme digest");
	});

	test("an unknown id is 404 job_not_found everywhere", async () => {
		const { app, alice } = await bootServer();
		expect(await call(app, "GET", "/v1/jobs/api:none", alice)).toMatchObject({
			status: 404,
			json: { error: "job_not_found" },
		});
		expect(await call(app, "PATCH", "/v1/jobs/api:none", alice, {})).toMatchObject({
			status: 404,
		});
		expect(await call(app, "DELETE", "/v1/jobs/api:none", alice)).toMatchObject({
			status: 404,
		});
		expect(await call(app, "POST", "/v1/jobs/api:none/run", alice)).toMatchObject({
			status: 404,
		});
	});

	test("POST validation rejections → 400 invalid_field with the field path", async () => {
		const { app, alice } = await bootServer();
		const badName = await call(app, "POST", "/v1/jobs", alice, promptSpec({ name: "Bad Name!" }));
		expect(badName).toMatchObject({ status: 400, json: { error: "invalid_field", field: "name" } });
		const noSchedule = await call(app, "POST", "/v1/jobs", alice, { name: "x", action: promptSpec().action });
		expect(noSchedule).toMatchObject({ status: 400, json: { error: "invalid_field", field: "schedule" } });
		const badCron = await call(app, "POST", "/v1/jobs", alice, promptSpec({ schedule: { cron: "not a cron" } }));
		expect(badCron).toMatchObject({ status: 400, json: { error: "invalid_field", field: "schedule.cron" } });
		const noBody = await call(app, "POST", "/v1/jobs", alice);
		expect(noBody).toMatchObject({ status: 400, json: { error: "invalid_field", field: "spec" } });
	});

	test("PATCH validates the MERGED spec (400 on an invalid partial)", async () => {
		const { app, alice } = await bootServer();
		const created = await call(app, "POST", "/v1/jobs", alice, promptSpec());
		const job = created.json.job;
		const bad = await call(app, "PATCH", `/v1/jobs/${job.id}`, alice, {
			schedule: { every: "nope" },
		});
		expect(bad).toMatchObject({
			status: 400,
			json: { error: "invalid_field", field: "schedule.every" },
		});
		// The rejected patch changed nothing.
		expect((await call(app, "GET", `/v1/jobs/${job.id}`, alice)).json.job.version).toBe(1);
	});

	test("the body's owner never overrides the stamped caller", async () => {
		const { app, alice } = await bootServer();
		const created = await call(app, "POST", "/v1/jobs", alice, promptSpec({ owner: "bob" }));
		expect(created.status).toBe(201);
		// Owner is server-stamped (§5.9 posture): alice created it, alice owns it.
		expect(created.json.job.owner).toBe("alice");
	});
});

describe("§5.9 job access — bob without a share", () => {
	test("hidden is 404 on every :id route and absent from the list", async () => {
		const { app, alice, bob } = await bootServer();
		const created = await call(app, "POST", "/v1/jobs", alice, promptSpec());
		const job = created.json.job;
		expect(await call(app, "GET", `/v1/jobs/${job.id}`, bob)).toMatchObject({
			status: 404,
			json: { error: "job_not_found" },
		});
		expect(await call(app, "POST", `/v1/jobs/${job.id}/run`, bob)).toMatchObject({
			status: 404,
		});
		expect(await call(app, "GET", `/v1/jobs/${job.id}/runs`, bob)).toMatchObject({
			status: 404,
		});
		expect(await call(app, "GET", `/v1/jobs/${job.id}/revisions`, bob)).toMatchObject({
			status: 404,
		});
		const listed = await call(app, "GET", "/v1/jobs", bob);
		expect(listed.json.jobs.some((one: any) => one.id === job.id)).toBe(false);
	});

	test("household-read: bob reads (200/list/runs) but writes are 403", async () => {
		const { app, alice, bob } = await bootServer();
		const created = await call(app, "POST", "/v1/jobs", alice, promptSpec());
		const job = created.json.job;
		const shared = await call(app, "PATCH", `/v1/jobs/${job.id}`, alice, {
			sharing: { scope: "household", level: "read" },
		});
		expect(shared.status).toBe(200);

		const got = await call(app, "GET", `/v1/jobs/${job.id}`, bob);
		expect(got.status).toBe(200);
		expect(got.json.job.access).toBe("read");
		const listed = await call(app, "GET", "/v1/jobs", bob);
		const row = listed.json.jobs.find((one: any) => one.id === job.id);
		expect(row.access).toBe("read");
		expect(
			(await call(app, "GET", `/v1/jobs/${job.id}/runs`, bob)).status,
		).toBe(200);
		expect(
			(await call(app, "GET", `/v1/jobs/${job.id}/revisions`, bob)).status,
		).toBe(200);

		expect(await call(app, "POST", `/v1/jobs/${job.id}/run`, bob)).toMatchObject({
			status: 403,
			json: { error: "forbidden" },
		});
		expect(await call(app, "PATCH", `/v1/jobs/${job.id}`, bob, {})).toMatchObject({
			status: 403,
		});
		expect(await call(app, "DELETE", `/v1/jobs/${job.id}`, bob)).toMatchObject({
			status: 403,
		});
	});
});

describe("declared jobs are immutable", () => {
	test("file: PATCH and DELETE → 409 job_declared; the job itself is readable", async () => {
		const id = "file:tick";
		const { app: adminApp, opened } = await bootServer({
			settings: { jobs: [promptSpec({ name: "tick" })] },
		});
		const admin = (await opened.identity.tokens.create("test", "tester")).token;
		const got = await call(adminApp, "GET", `/v1/jobs/${id}`, admin);
		expect(got.status).toBe(200);
		expect(got.json.job.owner).toBe("tester");
		expect(got.json.job.source).toBe("file");
		expect(await call(adminApp, "PATCH", `/v1/jobs/${id}`, admin, { enabled: false })).toMatchObject({
			status: 409,
			json: { error: "job_declared" },
		});
		expect(await call(adminApp, "DELETE", `/v1/jobs/${id}`, admin)).toMatchObject({
			status: 409,
			json: { error: "job_declared" },
		});
	});
});

describe("job-state lifecycle", () => {
	test("deleting an api job removes its populated state folder", async () => {
		const { app, dir, alice } = await bootServer();
		const created = await call(app, "POST", "/v1/jobs", alice, promptSpec());
		const state = statePath(dir, "alice", created.json.job.id);
		await seedState(state);
		expect(await call(app, "DELETE", `/v1/jobs/${created.json.job.id}`, alice)).toMatchObject({ status: 204 });
		expect(existsSync(state)).toBe(false);
	});

	test("resetState removes the folder for all three job sources; a later run may recreate it", async () => {
		const { app, opened, dir, alice } = await bootServer({
			settings: { jobs: [promptSpec({ name: "nightly-check", owner: "alice" })] },
			extensionSpecifiers: [pathToFileURL(join(import.meta.dirname, "fixtures", "fixture-jobs", "index.js")).href],
		});
		const created = await call(app, "POST", "/v1/jobs", alice, promptSpec());
		expect(created.status).toBe(201);
		const cases = [
			{ id: created.json.job.id, owner: "alice" },
			{ id: "file:nightly-check", owner: "alice" },
			{ id: "ext:fixture-jobs:tick", owner: "tester" },
		];
		for (const { id, owner } of cases) {
			const state = statePath(dir, owner, id);
			await seedState(state);
			await opened.jobs.resetState(id);
			expect(existsSync(state)).toBe(false);
			// The folder is only persistent state: the next run can create it anew.
			await seedState(state);
			expect(existsSync(state)).toBe(true);
		}
		await expect(opened.jobs.resetState("api:none")).rejects.toMatchObject({ name: "JobNotFoundError" });
	});

	test("reset route: write → 204 and folder gone; read → 403; unknown → 404", async () => {
		const { app, dir, alice, bob } = await bootServer();
		const created = await call(app, "POST", "/v1/jobs", alice, promptSpec({ sharing: { scope: "household", level: "read" } }));
		const id = created.json.job.id;
		const state = statePath(dir, "alice", id);
		await seedState(state);
		expect(await call(app, "POST", `/v1/jobs/${id}/state/reset`, bob)).toMatchObject({ status: 403, json: { error: "forbidden" } });
		expect(await call(app, "POST", "/v1/jobs/api:none/state/reset", alice)).toMatchObject({ status: 404, json: { error: "job_not_found" } });
		expect(await call(app, "POST", `/v1/jobs/${id}/state/reset`, alice)).toMatchObject({ status: 204 });
		expect(existsSync(state)).toBe(false);
	});

	test("reset removal failure → 500 state_reset_failed; delete failure → 204 plus a warning naming the path", async () => {
		const { app, dir, alice } = await bootServer();
		const created = await call(app, "POST", "/v1/jobs", alice, promptSpec());
		const id = created.json.job.id;
		const state = statePath(dir, "alice", id);
		await seedState(state);
		const removal = vi.mocked(removeJobState);
		removal.mockRejectedValueOnce(new Error("disk removal refused"));
		const reset = await call(app, "POST", `/v1/jobs/${id}/state/reset`, alice);
		expect(reset).toMatchObject({ status: 500, json: { error: "state_reset_failed", message: "disk removal refused" } });
		expect(existsSync(state)).toBe(true);

		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			removal.mockRejectedValueOnce(new Error("disk removal refused"));
			expect(await call(app, "DELETE", `/v1/jobs/${id}`, alice)).toMatchObject({ status: 204 });
			expect(existsSync(state)).toBe(true);
			expect(warning.mock.calls.some((call) => call.some((part) => String(part).includes(state)))).toBe(true);
		} finally {
			warning.mockRestore();
		}
	});
});

describe("deliver targets (gateway C7)", () => {
	test("accepts deliver on a new-conversation prompt; the created job carries it", async () => {
		const { app, alice } = await bootServer();
		const created = await call(app, "POST", "/v1/jobs", alice, {
			name: "nightly",
			schedule: { every: "3600s" },
			action: {
				kind: "prompt",
				prompt: "say ok",
				conversation: "new",
				deliver: ["telegram"],
			},
		});
		expect(created.status).toBe(201);
		// The validated spec PRESERVES deliver (it rides specHash + the fire).
		expect(created.json.job.action).toEqual({
			kind: "prompt",
			prompt: "say ok",
			conversation: "new",
			deliver: ["telegram"],
		});
	});

	test("rejects invalid deliver → 400 invalid_field action.deliver", async () => {
		const { app, alice } = await bootServer();
		const prompt = "say ok";
		// Every case names field action.deliver: deliver needs "new" (a fixed
		// conversation delivers via its own chat bindings, not this field),
		// and the array grammar is 1-8 entries of 1-256 chars.
		const cases = [
			{ kind: "prompt", prompt, conversation: 5, deliver: ["telegram"] },
			{ kind: "prompt", prompt, conversation: "new", deliver: [] },
			{
				kind: "prompt",
				prompt,
				conversation: "new",
				deliver: Array.from({ length: 9 }, (_, i) => `telegram:${i}`),
			},
			{ kind: "prompt", prompt, conversation: "new", deliver: [""] },
			{ kind: "prompt", prompt, conversation: "new", deliver: ["x".repeat(257)] },
			{ kind: "prompt", prompt, conversation: "new", deliver: "telegram" },
		];
		for (const action of cases) {
			const bad = await call(app, "POST", "/v1/jobs", alice, {
				name: "nightly",
				schedule: { every: "3600s" },
				action,
			});
			expect(bad).toMatchObject({
				status: 400,
				json: { error: "invalid_field", field: "action.deliver" },
			});
		}
	});
});

describe("run-now and the runs history", () => {
	test("run → outcome running + a conversation; the run lists first, manual, at the current version", async () => {
		const { app, alice } = await bootServer();
		const created = await call(app, "POST", "/v1/jobs", alice, promptSpec());
		const job = created.json.job;
		const fired = await call(app, "POST", `/v1/jobs/${job.id}/run`, alice);
		expect(fired.status).toBe(200);
		expect(fired.json.outcome).toBe("running");
		expect(typeof fired.json.conversationId).toBe("number");

		const runs = await call(app, "GET", `/v1/jobs/${job.id}/runs`, alice);
		expect(runs.status).toBe(200);
		const first = runs.json.runs[0];
		expect(first.jobId).toBe(job.id);
		expect(first.manual).toBe(true);
		expect(first.version).toBe(job.version);
		expect(first.conversationId).toBe(fired.json.conversationId);
		expect(["running", "succeeded"]).toContain(first.outcome);

		const versions = await call(app, "GET", `/v1/jobs/${job.id}/runs?limit=1`, alice);
		expect(versions.status).toBe(200);
		expect(versions.json.runs).toHaveLength(1);
	});

	test("limit grammar: 0 / non-integer → 400 invalid_field; above the cap clamps", async () => {
		const { app, alice } = await bootServer();
		const created = await call(app, "POST", "/v1/jobs", alice, promptSpec());
		const job = created.json.job;
		expect(await call(app, "GET", `/v1/jobs/${job.id}/runs?limit=0`, alice)).toMatchObject({
			status: 400,
			json: { error: "invalid_field", field: "limit" },
		});
		expect(await call(app, "GET", `/v1/jobs/${job.id}/runs?limit=-3`, alice)).toMatchObject({
			status: 400,
			json: { error: "invalid_field", field: "limit" },
		});
		expect(await call(app, "GET", `/v1/jobs/${job.id}/runs?limit=many`, alice)).toMatchObject({
			status: 400,
			json: { error: "invalid_field", field: "limit" },
		});
		// Above jobHistory.runs (default 50) clamps to the cap: still 200.
		expect(
			(await call(app, "GET", `/v1/jobs/${job.id}/runs?limit=100000`, alice))
				.status,
		).toBe(200);
	});
});
