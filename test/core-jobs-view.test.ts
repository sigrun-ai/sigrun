/**
 * Tabs+skills Task 5: the `core/jobs` blocks view (spec §8.4's jobs
 * surface, re-cast as a core view surface) — and the routes' shared
 * jobs access (`src/server/jobs-access.ts`).
 *
 * Pinned here:
 *
 * - `GET /v1/ext/core/surfaces/jobs` lists ONLY the caller-visible
 *   jobs (alice's own, one shared to her by user, one shared to a
 *   group she belongs to — never bob's private one), the SAME rows
 *   `GET /v1/jobs` stamps for her;
 * - the tree is DATA-BOUND (the Task 4 bump contract): the sidebar
 *   collection binds `{$: "/jobs"}` against the data document, so
 *   `job.changed → bumpAllInstances("core","jobs")` refreshes clients
 *   without a new tree;
 * - the selected job's main carries runs (newest 25, *Load more* →
 *   `runCursor`) and revisions (25 per page, *Load more* →
 *   `revCursor`); `?params={job,revision}` renders that revision's
 *   `diff` block of its spec JSON against the previous revision's;
 * - `runNow`/`resetState` need write access (read → the `{forbidden}`
 *   action error, and the buttons never render); `resetState` empties
 *   the job's state folder;
 * - a `job.changed` event bumps every rendered `core/jobs` instance
 *   through the events-bus side lane;
 * - parity with JobsPanel: schedule summary, next run, last outcome, a
 *   run's manual flag and error, a revision's changedBy and changedAt.
 *
 * Hermetic pattern: jobs-api.test.ts (token method, alice/bob
 * directory users, faux provider, `app.inject()`); groups ride alice's
 * directory record (`accessPrincipalOf` reads them live).
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineTask } from "@earendil-works/pi-durable";
import type { FastifyInstance } from "fastify";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { JobSpec, JobWire } from "@sigrun/shared/jobs";
import type { JsonObject } from "@sigrun/shared/blocks";
import { loadConfig } from "../src/config.js";
import { definedInOf } from "../src/server/core-views/jobs.js";
import { resolveActionBindings } from "../webui/src/blocks/context.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { jobStateDir } from "../src/jobs/state-dir.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly dir: string;
	readonly alice: string;
	readonly bob: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot one hermetic CLAIMED server under the token method. */
async function bootServer(options?: {
	/** Give alice the stored group `acme-ops` (the group-share case). */
	readonly aliceGroups?: readonly string[];
	/** Settings-file contents, written BEFORE boot (the `file:` job source).
	 *  The jobs-api.test.ts pattern; Task 4 reuses it. */
	readonly settings?: Record<string, unknown>;
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-core-jobs-view-"));
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
	await identity.users.add({
		user: "alice",
		admin: false,
		source: "cli",
		...(options?.aliceGroups === undefined
			? {}
			: {
					groups: [
						{
							source: "config",
							values: [...options.aliceGroups],
							updatedAt: Date.now(),
						},
					],
				}),
	});
	await identity.users.add({ user: "bob", admin: false, source: "cli" });
	const opened = await openHarness(config, {
		extensions: [contributor],
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

/** One injected request with auth (+ JSON content type for bodies). */
async function call(
	app: FastifyInstance,
	method: "GET" | "POST" | "PATCH" | "DELETE",
	url: string,
	token: string,
	body?: unknown,
): Promise<{ status: number; json: any }> {
	const response = await app.inject({
		method,
		url,
		...(body === undefined ? {} : { payload: JSON.stringify(body) }),
		headers: {
			authorization: `Bearer ${token}`,
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

/** One surface action dispatch (the §7.2 wire shape: action + payload + params in the body). */
async function act(
	app: FastifyInstance,
	token: string,
	action: string,
	payload: Record<string, unknown> | null,
	params: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
	return call(app, "POST", "/v1/ext/core/surfaces/jobs/actions", token, {
		action,
		payload,
		params,
	});
}

/** The jobs view (any params JSON rides the `params` query). */
function view(
	app: FastifyInstance,
	token: string,
	params?: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
	const base = "/v1/ext/core/surfaces/jobs";
	const url =
		params === undefined
			? base
			: `${base}?params=${encodeURIComponent(JSON.stringify(params))}`;
	return call(app, "GET", url, token);
}

/** A valid prompt spec (the shared body of the create calls). */
function promptSpec(name: string, overrides?: Partial<JobSpec>): JobSpec {
	return {
		name,
		schedule: { every: "3600s" },
		action: { kind: "prompt", prompt: "say ok", conversation: "new" },
		...overrides,
	};
}

/** Create one job as `token` (the caller is server-stamped as owner). */
async function createJob(
	app: FastifyInstance,
	token: string,
	spec: JobSpec,
): Promise<JobWire> {
	const created = await call(app, "POST", "/v1/jobs", token, spec);
	expect(created.status).toBe(201);
	return created.json.job as JobWire;
}

/** Walk one slot (sidebar/main), depth-first over layout children.
 *  A `page` block keeps its blocks in `main`/`sidebar`/`detail`
 *  (shared/src/blocks/types.ts) rather than `children`, so the walk
 *  descends those columns too — otherwise assertions over the whole
 *  tree (collectActionIds, assertActionBlocksValid) see the page node
 *  alone. */
function* walk(blocks: unknown): Generator<Record<string, any>> {
	if (!Array.isArray(blocks)) return;
	for (const block of blocks) {
		if (typeof block !== "object" || block === null) continue;
		const node = block as Record<string, any>;
		yield node;
		for (const column of ["children", "main", "sidebar", "detail"]) {
			if (!Array.isArray(node[column])) continue;
			for (const child of node[column]) {
				const inner =
					typeof child === "object" && child !== null && "block" in child
						? child.block
						: child;
				yield* walk([inner]);
			}
		}
	}
}

/** The one block of `type` in `blocks` (undefined when absent). */
function findBlock(
	blocks: unknown,
	type: string,
): Record<string, any> | undefined {
	for (const node of walk(blocks)) {
		if (node.type === type) return node;
	}
	return undefined;
}

/** Every block of `type` in `blocks`. */
function findBlocks(blocks: unknown, type: string): Record<string, any>[] {
	const found: Record<string, any>[] = [];
	for (const node of walk(blocks)) {
		if (node.type === type) found.push(node);
	}
	return found;
}

/** Read the data document's value at one JSON pointer. */
function atPointer(data: Record<string, any>, pointer: string): unknown {
	if (pointer === "") return data;
	let node: unknown = data;
	for (const token of pointer
		.split("/")
		.slice(1)
		.map((raw) => raw.replaceAll("~1", "/").replaceAll("~0", "~"))) {
		if (typeof node !== "object" || node === null) return undefined;
		node = (node as Record<string, unknown>)[token];
	}
	return node;
}

/**
 * Channel-shape assertion: walk the tree the way the channels do and
 * assert every block carrying `actions` is a type whose CONTRACT
 * includes them — `page`, `section`, `callout`, or a card template.
 */
function assertActionBlocksValid(root: Record<string, any>): void {
	const BLOCKS_WITH_ACTIONS = new Set(["page", "callout", "section"]);
	for (const node of walk([root])) {
		if (node.actions !== undefined && !BLOCKS_WITH_ACTIONS.has(node.type)) {
			throw new Error(
				`block "${node.id ?? node.type}" (type "${node.type}") carries actions — the channels silently drop them`,
			);
		}
		// Card templates are not walked by the channels as blocks; their
		// actions are validated by checkCard, not the block walk.
	}
}

/** Every text-ish literal of a callout (title + body + per-button label). */
function calloutsText(callouts: Record<string, any>[]): string[] {
	const out: string[] = [];
	for (const callout of callouts) {
		for (const key of ["title", "text", "body"]) {
			if (typeof callout[key] === "string") out.push(callout[key]);
		}
	}
	return out;
}

/** Every action id anywhere in the tree (page/callout actions + card templates). */
function collectActionIds(root: Record<string, any>): string[] {
	const ids: string[] = [];
	for (const node of walk([root])) {
		for (const action of node.actions ?? []) {
			if (typeof action?.id === "string") ids.push(action.id);
		}
		for (const action of node.item?.actions ?? []) {
			if (typeof action?.id === "string") ids.push(action.id);
		}
	}
	return ids;
}

/** Wait until `check` holds (the event-bus side lane is asynchronous). */
async function until(
	check: () => Promise<boolean> | boolean,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return;
		if (Date.now() > deadline) {
			throw new Error("condition did not hold within the timeout");
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

// ─── the list ─────────────────────────────────────────────────────────────

describe("core/jobs list (the caller-visible rows)", () => {
	test("lists only caller-visible jobs — alice's own, a user share, a group share; never bob's private one", async () => {
		const { app, alice, bob } = await bootServer({ aliceGroups: ["acme-ops"] });
		const own = await createJob(app, alice, promptSpec("acme-nightly"));
		const byUser = await createJob(
			app,
			bob,
			promptSpec("acme-user-share", {
				sharing: { scope: "people", users: ["alice"], level: "read" },
			}),
		);
		const byGroup = await createJob(
			app,
			bob,
			promptSpec("acme-group-share", {
				sharing: {
					scope: "people",
					users: [],
					groups: ["acme-ops"],
					level: "write",
				},
			}),
		);
		const hidden = await createJob(app, bob, promptSpec("acme-bob-private"));

		const rendered = await view(app, alice);
		expect(rendered.status).toBe(200);
		expect(rendered.json.access).toBe("write");
		const root = rendered.json.tree.root;
		expect(root.type).toBe("page");
		expect(root.title).toBe("Jobs");
		// The Task 4 bump contract: the sidebar collection BINDS the data
		// document (never literal rows inlined at render time), so
		// `surface.changed` refetches data against an unchanged tree.
		const sidebar = findBlock(root.sidebar, "collection");
		expect(sidebar).toBeDefined();
		expect(sidebar?.items).toEqual({ $: "/jobs" });
		const rows = atPointer(rendered.json.data, "/jobs") as any[];
		expect(Array.isArray(rows)).toBe(true);
		const ids = rows.map((row) => row.id);
		// The same rows GET /v1/jobs stamps for alice, in the same order.
		const api = await call(app, "GET", "/v1/jobs", alice);
		expect(ids).toEqual(api.json.jobs.map((one: any) => one.id));
		expect(ids).toContain(own.id);
		expect(ids).toContain(byUser.id);
		expect(ids).toContain(byGroup.id);
		expect(ids).not.toContain(hidden.id);
		// Parity fields on every row (the JobsPanel summary line).
		const ownRow = rows.find((row) => row.id === own.id);
		expect(ownRow.name).toBe("acme-nightly");
		expect(ownRow.scheduleSummary).toBe("every 3600s");
		expect("nextRun" in ownRow).toBe(true);
		expect("lastOutcome" in ownRow).toBe(true);
		// The drill-in rides the edit+itemId handler (review Critical 2:
		// navigate params are static and can never carry the row's id).
		expect(sidebar?.onActivate).toEqual({ type: "edit", name: "openJob" });
		expect(root.selection).toEqual({ selected: false, back: {} });
	});

	test("anonymous principals have access none; the userless superuser has the view", async () => {
		const { app, alice } = await bootServer();
		// The pipeline answers the no-credential call at the auth gate
		// (401 — the token method's answer for a missing Bearer), so the
		// view itself never even renders for an anonymous caller.
		const response = await app.inject({
			method: "GET",
			url: "/v1/ext/core/surfaces/jobs",
		});
		expect(response.statusCode).toBe(401);
		// The DEF's own anonymous gate: an anonymous principal renders
		// access `none` (the surface route's 404 shape). Service-level,
		// straight through the attached def.
		const def = app.surfaces.coreViewDefs.find((one) => one.id === "jobs");
		expect(def).toBeDefined();
		const rendered = await def!.render({
			principal: {
				user: undefined,
				admin: false,
				service: false,
				method: "token",
			},
			params: {},
			key: "anon",
			signal: new AbortController().signal,
		});
		expect(rendered.access).toBe("none");
		// Whole-branch review I3: the USERLESS SUPERUSER (the naive
		// single-operator loopback principal, `method: "none"` with no
		// user header) has the view — the /v1/jobs routes grant it write,
		// and the view is parity. Its list covers every job (the access
		// rule's superuser clause answers write for every row).
		const own = await createJob(app, alice, promptSpec("acme-nightly"));
		const naive = await def!.render({
			principal: {
				user: undefined,
				admin: false,
				service: false,
				method: "none",
			},
			params: {},
			key: "naive",
			signal: new AbortController().signal,
		});
		expect(naive.access).toBe("write");
		const ids = (atPointer(naive.data as Record<string, any>, "/jobs") as any[]).map(
			(row) => row.id,
		);
		expect(ids).toContain(own.id);
		// The P1 remainder: the ROW ACTIVATIONS must admit the superuser
		// too — openJob/openRevision used to hard-gate on a defined user
		// while the view rendered (navigation errored "forbidden").
		const naiveCtx = {
			principal: { user: undefined, admin: false, service: false, method: "none" as const },
			params: {},
			key: "naive",
			signal: new AbortController().signal,
		};
		const openedJob = await def!.actions?.openJob(naiveCtx, { itemId: own.id });
		expect(openedJob).toMatchObject({
			ok: true,
			navigate: { type: "navigate", params: { job: own.id } },
		});
		const openedRevision = await def!.actions?.openRevision(
			{ ...naiveCtx, params: { job: own.id } },
			{ itemId: "1" },
		);
		expect(openedRevision).toMatchObject({
			ok: true,
			navigate: { type: "navigate", params: { job: own.id, revision: 1 } },
		});
		// An anonymous NON-superuser still errors forbidden on both.
		const anonCtx = { ...naiveCtx, principal: { ...naiveCtx.principal, method: "token" as const } };
		expect(await def!.actions?.openJob(anonCtx, { itemId: own.id })).toEqual({
			ok: false,
			error: { message: "forbidden" },
		});
		expect(await def!.actions?.openRevision({ ...anonCtx, params: { job: own.id } }, { itemId: "1" })).toEqual({
			ok: false,
			error: { message: "forbidden" },
		});
	});

	test("an unknown or hidden `job` param renders the list with main empty state Job not found", async () => {
		const { app, alice, bob } = await bootServer();
		const own = await createJob(app, alice, promptSpec("acme-nightly"));
		const hidden = await createJob(app, bob, promptSpec("acme-bob-private"));
		for (const id of ["api:none", hidden.id]) {
			const rendered = await view(app, alice, { job: id });
			expect(rendered.status).toBe(200);
			const root = rendered.json.tree.root;
			expect(root.selection).toEqual({ selected: true, back: {} });
			expect(root.empty?.title).toBe("Job not found");
			const main = atPointer(rendered.json.data, "/main");
			expect((main as Record<string, any>).found).toBe(false);
			// The list still renders (the hidden job stays absent there too).
			const ids = (atPointer(rendered.json.data, "/jobs") as any[]).map(
				(row) => row.id,
			);
			expect(ids).toContain(own.id);
			expect(ids).not.toContain(hidden.id);
		}
	});
});

// ─── the selected job ─────────────────────────────────────────────────────

describe("core/jobs selected job", () => {
	test(
		"the selected job shows runs (manual flag, error, conversation) and revisions (changedBy, changedAt)",
		{ timeout: 30_000 },
		async () => {
		const { app, alice } = await bootServer();
		const job = await createJob(app, alice, promptSpec("acme-nightly"));
		const fired = await call(app, "POST", `/v1/jobs/${job.id}/run`, alice);
		expect(fired.json.outcome).toBe("running");
		const conversationId = fired.json.conversationId;
		// Wait for the run to settle so the manual flag/error/outcome are final.
		// 30 s: a run settles through the service's async lanes; a loaded
		// 2-core CI runner needs far more than the 5 s default.
		await until(
			async () => {
				const runs = await call(app, "GET", `/v1/jobs/${job.id}/runs`, alice);
				return runs.json.runs[0]?.outcome !== "running";
			},
			30_000,
		);
		await call(app, "PATCH", `/v1/jobs/${job.id}`, alice, {
			schedule: { cron: "0 3 * * *", timezone: "America/St_Johns" },
		});

		const rendered = await view(app, alice, { job: job.id });
		expect(rendered.status).toBe(200);
		const root = rendered.json.tree.root;
		expect(root.selection).toEqual({ selected: true, back: {} });
		const main = atPointer(rendered.json.data, "/main") as Record<string, any>;
		expect(main.found).toBe(true);
		expect(main.job.name).toBe("acme-nightly");
		expect(main.job.scheduleSummary).toBe("0 3 * * * (America/St_Johns)");
		expect("nextRun" in main.job).toBe(true);
		// Runs: newest first; the manual run carries its flag, outcome and
		// conversation navigation (the parity checklist).
		const runs = main.runs.items as any[];
		expect(runs).toHaveLength(1);
		expect(runs[0].manual).toBe(true);
		expect(["succeeded", "failed"]).toContain(runs[0].outcome);
		expect(runs[0].conversationId).toBe(conversationId);
		expect("error" in runs[0]).toBe(true);
		expect("at" in runs[0]).toBe(true);
		expect(main.runs.hasMore).toBe(false);
		// One row-bound Conversation template serves every run; a run
		// without a conversation resolves it away in the channel.
		const runButtons = findBlocks(root.main, "collection")
			.filter((one) => one.id === "runs")
			.flatMap((one) => one.item?.actions ?? []);
		expect(runButtons).toEqual([
			{
				id: "conversation",
				label: "Conversation",
				icon: "link",
				action: {
					type: "navigate",
					target: { conversation: { $: "./conversationId" } },
				},
			},
		]);
		// Revisions: newest first (v2 then v1), each with changedBy/changedAt.
		const revisions = main.revisions.items as any[];
		expect(revisions.map((one) => one.version)).toEqual([2, 1]);
		expect(revisions[0].changedBy).toBe("alice");
		expect(typeof revisions[0].changedAt).toBe("string");
		expect(main.revisions.hasMore).toBe(false);
		// No revision param → no diff block.
		expect(findBlock(root.main, "diff")).toBeUndefined();
	});

	test("the revision diff is the spec JSON before/after (previous revision, pretty-printed)", async () => {
		const { app, alice } = await bootServer();
		const job = await createJob(app, alice, promptSpec("acme-nightly"));
		const patch = promptSpec("acme-nightly", {
			action: { kind: "prompt", prompt: "say tock", conversation: "new" },
		});
		await call(app, "PATCH", `/v1/jobs/${job.id}`, alice, patch);

		const rendered = await view(app, alice, { job: job.id, revision: 2 });
		expect(rendered.status).toBe(200);
		const diff = findBlock(rendered.json.tree.root.main, "diff");
		expect(diff).toBeDefined();
		// before = the previous revision's spec, after = the selected one's
		// (the JobsPanel diff rule), both the 2-space JSON print.
		expect(diff?.before).toBe(JSON.stringify(promptSpec("acme-nightly"), null, 2));
		// The stored spec carries the merged `enabled` default (the
		// create stamped it; the patch preserved it through the merge).
		expect(diff?.after).toBe(
			JSON.stringify({ ...patch, enabled: true }, null, 2),
		);
		// A revision row's activation dispatches openRevision (the {itemId}
		// pattern — a static navigate could never carry the ACTIVATED row's
		// version, whole-branch review I1).
		const list = findBlocks(rendered.json.tree.root.main, "collection").find(
			(one) => one.id === "revisions",
		);
		expect(list?.onActivate).toEqual({ type: "edit", name: "openRevision" });
		// The oldest revision (v1, no previous) renders no diff.
		const oldest = await view(app, alice, { job: job.id, revision: 1 });
		expect(findBlock(oldest.json.tree.root.main, "diff")).toBeUndefined();
	});

	test("openRevision navigates to the ACTIVATED row's revision ({job, revision})", async () => {
		// Whole-branch review I1: with revision 3 selected, activating the
		// revision-7 row must navigate to 7 — never re-navigate to 3 (the
		// old static navigate did exactly that).
		const { app, opened, alice } = await bootServer();
		const job = await createJob(app, alice, promptSpec("acme-nightly"));
		for (let version = 2; version <= 7; version += 1) {
			await opened.jobs.updateApi(
				job.id,
				{ schedule: { every: `${3600 + version}s` } },
				"alice",
			);
		}
		// The revision rows' ids ARE the versions (the {itemId} source).
		const rendered = await view(app, alice, { job: job.id, revision: 3 });
		const rows = (rendered.json.data as any).main.revisions.items as any[];
		expect(rows[0]?.id).toBe("7");
		// Activating the revision-7 row (while 3 is selected) navigates to 7.
		const activated = await act(
			app,
			alice,
			"openRevision",
			{ itemId: "7" },
			{ job: job.id, revision: 3 },
		);
		expect(activated.status).toBe(200);
		// The wire envelope also stamps `rev` (the instance revision) —
		// match the carried shape, not the whole envelope.
		expect(activated.json).toMatchObject({
			ok: true,
			navigate: {
				type: "navigate",
				params: { job: job.id, revision: 7 },
			},
		});
		// A bad item id is a clean error.
		const bad = await act(
			app,
			alice,
			"openRevision",
			{ itemId: "not-a-revision" },
			{ job: job.id },
		);
		expect(bad.json.ok).toBe(false);
		// No selected job → a clean error (the job rides the params).
		const noJob = await act(app, alice, "openRevision", { itemId: "2" }, {});
		expect(noJob.json).toEqual({
			ok: false,
			error: { message: "openRevision needs a selected job (params.job)" },
		});
	});

	test(
		"runs page by 25 (runCursor); revisions page by 25 (revCursor)",
		{ timeout: 180_000 },
		async () => {
		const { app, opened, alice } = await bootServer();
		const job = await createJob(app, alice, promptSpec("acme-nightly"));
		// 30 revisions (versions 1..30) without the route's per-patch cost.
		for (let version = 2; version <= 30; version += 1) {
			await opened.jobs.updateApi(
				job.id,
				{ schedule: { every: `${3600 + version}s` } },
				"alice",
			);
		}
		// 26 runs, fired straight through the service (the faux model settles).
		// Regression pin (pi-durable 1.5.0 lane): the manual run-record key
		// is derived from the fire's fireAt — the SAME clock reading as the
		// fire-key tail — never startedAt. When the clock rolls over one ms
		// between the two stamps, a startedAt-derived settle key misses the
		// stored run doc by 1ms and the run wedges `running` forever; 26
		// rapid fires make that rollover near-certain.
		for (let run = 0; run < 26; run += 1) {
			await opened.jobs.runNow(job.id);
		}
		await until(
			async () => {
				const runs = await call(app, "GET", `/v1/jobs/${job.id}/runs?limit=26`, alice);
				return (
					runs.json.runs.length === 26 &&
					runs.json.runs.every((one: any) => one.outcome !== "running")
				);
			},
			120_000,
		);

		// Runs: newest 25 on the first page, Load more → runCursor → the rest.
		const first = await view(app, alice, { job: job.id });
		const firstMain = atPointer(first.json.data, "/main") as Record<string, any>;
		expect(firstMain.runs.items).toHaveLength(25);
		expect(firstMain.runs.hasMore).toBe(true);
		const runCursor = firstMain.runs.nextRunCursor;
		expect(typeof runCursor).toBe("string");
		const second = await view(app, alice, { job: job.id, runCursor });
		const secondMain = atPointer(second.json.data, "/main") as Record<string, any>;
		expect(secondMain.runs.items).toHaveLength(1);
		expect(secondMain.runs.hasMore).toBe(false);
		// No overlap and no loss across the two pages (newest-first).
		const allRunIds = [
			...(firstMain.runs.items as any[]),
			...(secondMain.runs.items as any[]),
		].map((one) => one.id);
		const api = await call(app, "GET", `/v1/jobs/${job.id}/runs?limit=26`, alice);
		expect(allRunIds).toHaveLength(26);
		for (const one of api.json.runs) {
			expect(allRunIds).toContain(`${one.jobId}:${one.fireAt}`);
		}

		// Revisions: 25 per page; Load more → revCursor (a plain offset).
		const revs1 = await view(app, alice, { job: job.id });
		const revs1Main = atPointer(revs1.json.data, "/main") as Record<string, any>;
		expect(revs1Main.revisions.items).toHaveLength(25);
		expect(revs1Main.revisions.hasMore).toBe(true);
		expect(revs1Main.revisions.nextRevCursor).toBe(25);
		const revs2 = await view(app, alice, { job: job.id, revCursor: 25 });
		const revs2Main = atPointer(revs2.json.data, "/main") as Record<string, any>;
		expect((revs2Main.revisions.items as any[]).map((one) => one.version)).toEqual([
			5, 4, 3, 2, 1,
		]);
		expect(revs2Main.revisions.hasMore).toBe(false);
		// The oldest page renders the diff of v5 against v4 when selected.
		const diff = await view(app, alice, { job: job.id, revCursor: 25, revision: 5 });
		const block = findBlock(diff.json.tree.root.main, "diff");
		expect(block).toBeDefined();
		const revisions = await call(app, "GET", `/v1/jobs/${job.id}/revisions`, alice);
		const v5 = revisions.json.revisions.find((one: any) => one.version === 5);
		const v4 = revisions.json.revisions.find((one: any) => one.version === 4);
		expect(block?.after).toBe(JSON.stringify(v5.spec, null, 2));
		expect(block?.before).toBe(JSON.stringify(v4.spec, null, 2));
	});
});

// ─── actions ──────────────────────────────────────────────────────────────

describe("core/jobs view polish", () => {
	test("one Conversation button per run, bound to its own conversation", async () => {
		const { app, opened, alice } = await bootServer();
		const job = await createJob(app, alice, promptSpec("acme-nightly"));
		const first = await opened.jobs.runNow(job.id);
		const second = await opened.jobs.runNow(job.id);
		expect(first.conversationId).not.toBe(second.conversationId);
		const rendered = await view(app, alice, { job: job.id });
		const runs = findBlocks(rendered.json.tree.root.main, "collection").find((one) => one.id === "runs");
		expect(runs?.item?.actions).toEqual([
			{
				id: "conversation",
				label: "Conversation",
				icon: "link",
				action: {
					type: "navigate",
					target: { conversation: { $: "./conversationId" } },
				},
			},
		]);
		expect(JSON.stringify(runs?.item?.actions)).not.toContain(String(first.conversationId));
		expect(JSON.stringify(runs?.item?.actions)).not.toContain(String(second.conversationId));
	});

	test("a task run omits its Conversation binding while a prompt run keeps it", async () => {
		const { app, opened, alice } = await bootServer({
			settings: {
				jobs: [
					{
						name: "acme-task-job",
						owner: "alice",
						schedule: { every: "3600s" },
						action: { kind: "task", task: "acme-fixture-task" },
					},
				],
			},
		});
		opened.registry.install({
			name: "acme-task-fixture",
			tasks: [defineTask<Record<string, never>, { phase: "done" }, void, object>({
				name: "acme-fixture-task",
				version: 1,
				initial: () => ({ phase: "done" }),
				phases: { done: async () => {} },
				abort: async () => {},
			})],
		});
		const promptJob = await createJob(app, alice, promptSpec("acme-prompt-job"));
		const promptFire = await opened.jobs.runNow(promptJob.id);
		const taskFire = await opened.jobs.runNow("file:acme-task-job");
		expect(promptFire.conversationId).toBeTypeOf("number");
		expect(taskFire.conversationId).toBeUndefined();
		const rendered = await view(app, alice, { job: "file:acme-task-job" });
		const rows = (atPointer(rendered.json.data, "/main/runs/items") as any[]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).not.toHaveProperty("conversationId");
		const runs = findBlocks(rendered.json.tree.root.main, "collection").find((one) => one.id === "runs");
		const button = runs?.item?.actions?.[0];
		expect(button?.label).toBe("Conversation");
		const resolve = (row: JsonObject) => resolveActionBindings(button.action, {
			data: {},
			item: row,
			locale: "en-US",
		});
		expect(resolve(rows[0])).toBeUndefined();
		expect(resolve({ ...rows[0], conversationId: promptFire.conversationId })).toEqual({
			type: "navigate",
			target: { conversation: promptFire.conversationId },
		});
	});

	test("job actions ride the summary section", async () => {
		const { app, alice } = await bootServer();
		const job = await createJob(app, alice, promptSpec("acme-nightly"));
		const rendered = await view(app, alice, { job: job.id });
		const summary = findBlocks(rendered.json.tree.root.main, "section").find((one) => one.id === "job-summary");
		expect((summary?.actions ?? []).map((one: any) => one.id)).toEqual([
			"run-now",
			"reset-state",
			"job-edit",
			"job-delete",
		]);
		expect(findBlocks(rendered.json.tree.root.main, "callout").some((one) => one.id === "job-actions")).toBe(false);
		assertActionBlocksValid(rendered.json.tree.root);
	});

	test("empty summary rows are omitted", async () => {
		const { app, alice } = await bootServer();
		const job = await createJob(app, alice, promptSpec("acme-nightly"));
		const rendered = await view(app, alice, { job: job.id });
		const summary = findBlocks(rendered.json.tree.root.main, "section").find((one) => one.id === "job-summary");
		const fields = findBlocks(summary?.children, "fields")[0];
		expect(fields?.hideEmpty).toBe(true);
	});

	test("the prompt has its own section", async () => {
		const { app, alice } = await bootServer();
		const job = await createJob(app, alice, promptSpec("acme-nightly"));
		const rendered = await view(app, alice, { job: job.id });
		const section = findBlocks(rendered.json.tree.root.main, "section").find((one) => one.id === "job-prompt");
		expect(section?.title).toBe("Prompt");
		expect(findBlocks(section?.children, "markdown").map((one) => one.text)).toEqual([
			{ $: "/main/job/prompt" },
			{ $: "/main/job/taskInputMarkdown" },
		]);
		const summary = findBlocks(rendered.json.tree.root.main, "section").find((one) => one.id === "job-summary");
		expect(findBlocks(summary?.children, "markdown")).toEqual([]);
	});
});

describe("core/jobs actions", () => {
	test("runNow requires write access (read → the forbidden action error; the buttons hide)", async () => {
		const { app, alice, bob } = await bootServer();
		const job = await createJob(
			app,
			alice,
			promptSpec("acme-nightly", {
				sharing: { scope: "household", level: "read" },
			}),
		);

		// The writer's tree offers both buttons (with the reset confirm)
		// on the summary section's header.
		const writers = await view(app, alice, { job: job.id });
		const summary = findBlocks(writers.json.tree.root.main, "section").find(
			(one) => one.id === "job-summary",
		);
		expect(summary).toBeDefined();
		const offered = (summary?.actions ?? []).map((one: any) => one.id);
		expect(offered).toContain("run-now");
		expect(offered).toContain("reset-state");
		const resetButton = (summary?.actions ?? []).find(
			(one: any) => one.id === "reset-state",
		);
		expect(resetButton?.action?.confirm?.body).toBe(
			"Reset this job's state? Its state folder is emptied.",
		);
		// Channel-shape assertion: every block carrying `actions` in the
		// served tree is a type whose contract includes actions.
		assertActionBlocksValid(writers.json.tree.root);

		// The reader's tree hides both.
		const readers = await view(app, bob, { job: job.id });
		const readSummary = findBlocks(readers.json.tree.root.main, "section").find(
			(one) => one.id === "job-summary",
		);
		expect(readSummary?.actions ?? []).toEqual([]);

		// runNow as the writer fires the job (the surface renders first,
		// so the action route's access gate has the instance cached).
		expect((await view(app, alice, { job: job.id })).status).toBe(200);
		const fired = await act(app, alice, "runNow", { jobId: job.id }, { job: job.id });
		expect(fired.status).toBe(200);
		expect(fired.json.ok).toBe(true);
		expect(fired.json.toast).toContain("acme-nightly");
		const runs = await call(app, "GET", `/v1/jobs/${job.id}/runs`, alice);
		expect(runs.json.runs[0]?.manual).toBe(true);

		// runNow as the reader is the forbidden action error (the route's
		// 403 gate is bypassed: the surface access is read-OR-write per
		// the LIST; the job-level write rule lives in the handler).
		expect((await view(app, bob, { job: job.id })).status).toBe(200);
		const denied = await act(app, bob, "runNow", { jobId: job.id }, { job: job.id });
		expect(denied.status).toBe(200);
		expect(denied.json).toEqual({ ok: false, error: { message: "forbidden" } });

		// resetState as the reader is likewise forbidden.
		const deniedReset = await act(
			app,
			bob,
			"resetState",
			{ jobId: job.id },
			{ job: job.id },
		);
		expect(deniedReset.json).toEqual({ ok: false, error: { message: "forbidden" } });
	});

	test("the null-payload path resolves the job from the instance params (params.job)", async () => {
		const { app, alice, bob } = await bootServer();
		// Shared read: bob sees the job (access read), so the surface
		// action reaches the handler, where the job-level write rule is
		// the forbidden (the existing runNow test's access shape).
		const job = await createJob(
			app,
			alice,
			promptSpec("acme-nightly", {
				sharing: { scope: "household", level: "read" },
			}),
		);

		// The instance renders first (the action route resolves the
		// instance's access through the cached/first render).
		expect((await view(app, alice, { job: job.id })).status).toBe(200);
		expect((await view(app, bob, { job: job.id })).status).toBe(200);

		// (a) payload null → params.job: the owner's button-shaped
		// dispatch (both channels send a null payload for a plain callout
		// button) fires the job and records a run.
		const fired = await act(app, alice, "runNow", null, { job: job.id });
		expect(fired.status).toBe(200);
		expect(fired.json.ok).toBe(true);
		expect(fired.json.toast).toContain("acme-nightly");
		const runs = await call(app, "GET", `/v1/jobs/${job.id}/runs`, alice);
		expect(runs.json.runs[0]?.manual).toBe(true);

		// (b) payload null → params.job: the reader's dispatch is the
		// job-level forbidden (the payload override never sees the wire).
		const denied = await act(app, bob, "runNow", null, { job: job.id });
		expect(denied.status).toBe(200);
		expect(denied.json).toEqual({ ok: false, error: { message: "forbidden" } });
		const deniedReset = await act(app, bob, "resetState", null, { job: job.id });
		expect(deniedReset.json).toEqual({ ok: false, error: { message: "forbidden" } });

		// (c) no selection at all: neither payload nor params names a job.
		expect((await view(app, alice)).status).toBe(200);
		const unselected = await act(app, alice, "runNow", null, {});
		expect(unselected.json).toEqual({
			ok: false,
			error: { message: "runNow needs a selected job (params.job)" },
		});
		const unselectedReset = await act(app, alice, "resetState", null, {});
		expect(unselectedReset.json).toEqual({
			ok: false,
			error: { message: "resetState needs a selected job (params.job)" },
		});
	});

	test("resetState empties the job state folder", async () => {
		const { app, dir, alice } = await bootServer();
		const job = await createJob(app, alice, promptSpec("acme-nightly"));
		const state = jobStateDir(join(dir, "data", "users", "alice", "jobs"), job.id);
		await mkdir(state, { recursive: true });
		await writeFile(join(state, "notes.json"), "{}");
		expect(existsSync(state)).toBe(true);

		// The instance renders first (the action route resolves the
		// instance's access through the cached/first render).
		expect((await view(app, alice, { job: job.id })).status).toBe(200);
		const reset = await act(
			app,
			alice,
			"resetState",
			{ jobId: job.id },
			{ job: job.id },
		);
		expect(reset.status).toBe(200);
		expect(reset.json).toMatchObject({ ok: true });
		expect(existsSync(state)).toBe(false);
	});
});

// ─── per-row drill-in (review Critical 2) ───────────────────────────────

describe("core/jobs per-row drill-in (openJob)", () => {
	test("activating a sidebar row navigates to THAT row's job (edit+itemId handler)", async () => {
		const { app, alice } = await bootServer();
		const first = await createJob(app, alice, promptSpec("acme-first"));
		const second = await createJob(app, alice, promptSpec("acme-second"));
		// Render first (the action route's access gate needs the instance).
		expect((await view(app, alice)).status).toBe(200);

		// The emitted navigation names the ACTIVATED row's job — never the
		// currently-selected one (a static navigate param could only do the
		// latter, which was the Critical 2 defect).
		const activated = await act(app, alice, "openJob", { itemId: second.id }, {});
		expect(activated.status).toBe(200);
		expect(activated.json.ok).toBe(true);
		expect(activated.json.navigate).toEqual({
			type: "navigate",
			params: { job: second.id },
		});
		const activatedFirst = await act(app, alice, "openJob", { itemId: first.id }, {});
		expect(activatedFirst.json.navigate).toEqual({
			type: "navigate",
			params: { job: first.id },
		});

		// A missing/empty itemId is a clean action error.
		const missing = await act(app, alice, "openJob", {}, {});
		expect(missing.json).toEqual({
			ok: false,
			error: { message: "openJob expects {itemId}" },
		});
		const empty = await act(app, alice, "openJob", { itemId: "" }, {});
		expect(empty.json).toEqual({
			ok: false,
			error: { message: "openJob expects {itemId}" },
		});
	});
});

// ─── freshness ────────────────────────────────────────────────────────────

describe("core/jobs freshness", () => {
	test("a job.changed event bumps every core/jobs instance (the Task 4 wiring)", async () => {
		const { app, alice } = await bootServer();
		const job = await createJob(app, alice, promptSpec("acme-nightly"));
		const list = await view(app, alice);
		expect(list.json.rev).toBe(0);
		const selected = await view(app, alice, { job: job.id });
		expect(selected.json.rev).toBe(0);

		// A record change publishes job.changed; the server bumps every
		// rendered instance's rev through the bus's bounded side lane.
		await call(app, "PATCH", `/v1/jobs/${job.id}`, alice, {
			schedule: { every: "7200s" },
		});
		await until(async () => {
			const again = await view(app, alice);
			const againSelected = await view(app, alice, { job: job.id });
			return again.json.rev >= 1 && againSelected.json.rev >= 1;
		});
		// The bump is a DATA refresh: the static tree serves the new data.
		const again = await view(app, alice);
		const row = (atPointer(again.json.data, "/jobs") as any[]).find(
			(one) => one.id === job.id,
		);
		expect(row.scheduleSummary).toBe("every 7200s");
	});
});

// ─── details + provenance ───────────────────────────────────────────────

describe("core/jobs details + provenance", () => {
	test("definedInOf names the source from the id", () => {
		expect(definedInOf("file:acme-nightly", "file")).toBe(
			"settings.json (jobs → acme-nightly)",
		);
		expect(definedInOf("ext:acme-tool:acme-tick", "extension")).toBe(
			"the acme-tool extension",
		);
		expect(definedInOf("api:0000", "api")).toBe("created in sigrun");
	});

	test("a prompt job's details bind description, provenance and action", async () => {
		const { app, alice } = await bootServer();
		const job = await createJob(app, alice, {
			...promptSpec("acme-nightly"),
			description: "acme digest",
		});
		const rendered = await view(app, alice, { job: job.id });
		expect(rendered.status).toBe(200);
		const main = atPointer(rendered.json.data, "/main") as Record<string, any>;
		expect(main.job.description).toBe("acme digest");
		expect(main.job.definedIn).toBe("created in sigrun");
		expect(main.job.source).toBe("api");
		expect(main.job.kind).toBe("prompt");
		expect(main.job.prompt).toBe("say ok");
		expect(main.job.conversation).toBe("new");
		expect(main.job.deliver).toBeNull();
		// The sidebar row carries the description subtitle.
		const rows = atPointer(rendered.json.data, "/jobs") as any[];
		expect(rows.find((row) => row.id === job.id)?.description).toBe(
			"acme digest",
		);
		// The tree binds the prompt as a markdown block.
		const promptBlock = findBlocks(
			rendered.json.tree.root.main,
			"markdown",
		).find((one) => (one.text as any)?.$ === "/main/job/prompt");
		expect(promptBlock).toBeDefined();
	});

	test("a declared job shows the read-only callout and no edit/delete buttons", async () => {
		const { app, alice } = await bootServer({
			settings: {
				jobs: [{ ...promptSpec("acme-file"), owner: "alice" }],
			},
		});
		const rendered = await view(app, alice, { job: "file:acme-file" });
		expect(rendered.status).toBe(200);
		const callouts = findBlocks(rendered.json.tree.root.main, "callout");
		expect(
			calloutsText(callouts).some((text) =>
				text.includes("Defined in settings.json — edit it there"),
			),
		).toBe(true);
		// No edit affordances for a declared job anywhere in the tree.
		const actionIds = collectActionIds(rendered.json.tree.root);
		expect(actionIds).not.toContain("job-edit");
		expect(actionIds).not.toContain("job-delete");
	});

	test("a task job's input renders as a bound json code block", async () => {
		const { app, alice } = await bootServer({
			settings: {
				jobs: [
					{
						name: "acme-task-job",
						owner: "alice",
						schedule: { every: "3600s" },
						action: { kind: "task", task: "acme-task", input: { a: 1 } },
					},
				],
			},
		});
		const rendered = await view(app, alice, { job: "file:acme-task-job" });
		expect(rendered.status).toBe(200);
		const main = atPointer(rendered.json.data, "/main") as Record<string, any>;
		expect(main.job.kind).toBe("task");
		expect(main.job.task).toBe("acme-task");
		expect(main.job.taskInputMarkdown).toBe(
			'```json\n{\n  "a": 1\n}\n```',
		);
		const inputBlock = findBlocks(
			rendered.json.tree.root.main,
			"markdown",
		).find((one) => (one.text as any)?.$ === "/main/job/taskInputMarkdown");
		expect(inputBlock).toBeDefined();
	});
});

// ─── New job (jobs-editor Task 3) ──────────────────────────────────────────

describe("core/jobs New job (the form + createJob)", () => {
	test("New job opens the form: selected, no Job not found, seeded /form", async () => {
		const { app, alice } = await bootServer();
		const rendered = await view(app, alice, { edit: true });
		expect(rendered.status).toBe(200);
		const root = rendered.json.tree.root;
		expect(root.selection.selected).toBe(true);
		expect(root.empty).toBeUndefined();
		// No "Job not found" empty state anywhere in the main column.
		const texts = findBlocks(root.main, "markdown").map((b) => b.text);
		expect(texts).not.toContain("Job not found");
		// The form block (validateTree requires its id; both channels
		// default the label to "Submit" — the form pins "Create").
		const form = findBlock(root.main, "form");
		expect(form).toBeDefined();
		expect(form?.id).toBe("job-form");
		expect(form?.bind).toBe("/form");
		expect(form?.onSubmit).toBe("createJob");
		expect(form?.submitLabel).toBe("Create");
		// The seeded form values ride the data document.
		const data = rendered.json.data as Record<string, any>;
		expect(data.form).toEqual({
			name: "",
			description: "",
			scheduleType: "cron",
			schedule: "",
			timezone: "",
			prompt: "",
			model: "default",
			thinking: "default",
			maxTurns: null,
			enabled: true,
		});
		// Model options: Default first, the faux provider's model present.
		expect(data.modelOptions[0]).toEqual({ id: "default", label: "Default" });
		expect(data.modelOptions).toContainEqual(
			expect.objectContaining({ id: "faux/m" }),
		);
		// The page's New job action navigates {edit: true}.
		const jobNew = (root.actions ?? []).find(
			(action: any) => action.id === "job-new",
		);
		expect(jobNew).toBeDefined();
		expect(jobNew.label).toBe("New job");
		expect(jobNew.action).toEqual({
			type: "navigate",
			params: { edit: true },
		});
		assertActionBlocksValid(root);
	});

	test("createJob creates an api job owned by the caller and navigates to it", async () => {
		const { app, alice } = await bootServer();
		const json = await act(
			app,
			alice,
			"createJob",
			{
				values: {
					name: "acme-created",
					description: "made in the view",
					scheduleType: "every",
					schedule: "15m",
					prompt: "say ok",
					model: "default",
					thinking: "default",
					enabled: true,
				},
			},
			{ edit: true },
		);
		expect(json.status).toBe(200);
		expect(json.json.ok).toBe(true);
		expect(json.json.toast).toBe("Created acme-created");
		const jobId = json.json.navigate.params.job as string;
		expect(jobId.startsWith("api:")).toBe(true);
		const fetched = await call(app, "GET", `/v1/jobs/${encodeURIComponent(jobId)}`, alice);
		expect(fetched.status).toBe(200);
		expect(fetched.json.job.owner).toBe("alice");
		expect(fetched.json.job.action.conversation).toBe("new");
		expect(fetched.json.job.description).toBe("made in the view");
	});

	test("createJob field errors come back field-scoped", async () => {
		const { app, alice } = await bootServer();
		const json = await act(
			app,
			alice,
			"createJob",
			{
				values: {
					name: "acme-bad-cron",
					scheduleType: "cron",
					schedule: "0 25 * * *",
					prompt: "say ok",
					model: "default",
					thinking: "default",
					enabled: true,
				},
			},
			{ edit: true },
		);
		expect(json.status).toBe(200);
		expect(json.json.ok).toBe(false);
		expect(json.json.error.field).toBe("schedule");
	});

	test("an anonymous caller cannot create", async () => {
		const { app } = await bootServer();
		// Over HTTP an anonymous caller is a 401 at the auth pipeline, so
		// this asserts the DEF's own admission rule (the file's
		// "anonymous principals" pattern).
		const def = app.surfaces.coreViewDefs.find((one) => one.id === "jobs");
		expect(def).toBeDefined();
		const result = await def!.actions?.createJob(
			{
				principal: {
					user: undefined,
					admin: false,
					service: false,
					method: "token" as const,
				},
				params: { edit: true },
				key: "anon",
				signal: new AbortController().signal,
			},
			{
				values: {
					name: "acme-anon",
					scheduleType: "every",
					schedule: "15m",
					prompt: "say ok",
				},
			},
		);
		expect(result).toEqual({ ok: false, error: { message: "forbidden" } });
	});
});

// ─── Edit + Delete (jobs-editor Task 4) ────────────────────────────────────

describe("core/jobs Edit + Delete (saveJob/deleteJob)", () => {
	test("clearing description removes the key", async () => {
		const { app, alice } = await bootServer();
		const job = await createJob(app, alice, {
			...promptSpec("acme-described"),
			description: "acme digest",
		});
		// The instance renders first (the action route's access gate).
		expect((await view(app, alice, { job: job.id, edit: true })).status).toBe(200);
		const saved = await act(
			app,
			alice,
			"saveJob",
			{
				values: {
					name: "acme-described",
					description: "",
					scheduleType: "every",
					schedule: "3600s",
					prompt: "say ok",
					model: "default",
					thinking: "default",
					enabled: true,
				},
			},
			{ job: job.id, edit: true },
		);
		expect(saved.status).toBe(200);
		expect(saved.json.ok).toBe(true);
		expect(saved.json.navigate).toEqual({
			type: "navigate",
			params: { job: job.id },
		});
		// The served wire row and the latest revision's spec both lack
		// the key entirely (the spread + JSON round-trip dropped it).
		const fetched = await call(app, "GET", `/v1/jobs/${job.id}`, alice);
		expect("description" in fetched.json.job).toBe(false);
		const revisions = await call(app, "GET", `/v1/jobs/${job.id}/revisions`, alice);
		const latest = revisions.json.revisions.find((one: any) => one.version === 2);
		expect("description" in latest.spec).toBe(false);
	});

	test("saveJob renames and edits the prompt; navigates back to the job", async () => {
		const { app, alice } = await bootServer();
		const job = await createJob(app, alice, promptSpec("acme-nightly"));
		expect((await view(app, alice, { job: job.id, edit: true })).status).toBe(200);
		const saved = await act(
			app,
			alice,
			"saveJob",
			{
				values: {
					name: "acme-renamed",
					description: "",
					scheduleType: "every",
					schedule: "2h",
					prompt: "say tock",
					model: "faux/m",
					thinking: "low",
					enabled: true,
				},
			},
			{ job: job.id, edit: true },
		);
		expect(saved.json.ok).toBe(true);
		expect(saved.json.navigate).toEqual({
			type: "navigate",
			params: { job: job.id },
		});
		const fetched = await call(app, "GET", `/v1/jobs/${job.id}`, alice);
		expect(fetched.json.job.name).toBe("acme-renamed");
		expect(fetched.json.job.action).toEqual({
			kind: "prompt",
			prompt: "say tock",
			model: "faux/m",
			thinking: "low",
			conversation: "new",
		});
		expect(fetched.json.job.schedule).toEqual({ every: "2h" });
	});

	test("the edit branch renders the seeded form; a declared job renders the details instead", async () => {
		const { app, alice } = await bootServer({
			settings: {
				jobs: [{ ...promptSpec("acme-file"), owner: "alice" }],
			},
		});
		const job = await createJob(app, alice, {
			...promptSpec("acme-nightly"),
			description: "acme digest",
		});
		const rendered = await view(app, alice, { job: job.id, edit: true });
		expect(rendered.status).toBe(200);
		const form = findBlock(rendered.json.tree.root.main, "form");
		expect(form).toBeDefined();
		expect(form?.id).toBe("job-form");
		expect(form?.onSubmit).toBe("saveJob");
		expect(form?.submitLabel).toBe("Save");
		// Seeded from the job's current spec.
		const data = rendered.json.data as Record<string, any>;
		expect(data.form).toMatchObject({
			name: "acme-nightly",
			description: "acme digest",
			scheduleType: "every",
			schedule: "3600s",
			prompt: "say ok",
			model: "default",
			thinking: "default",
			enabled: true,
		});
		// Write actions include edit+delete with the confirm copy on the
		// DETAILS page's summary section (edit mode renders the form).
		expect(findBlock(rendered.json.tree.root.main, "form")).toBeDefined();
		const details = await view(app, alice, { job: job.id });
		const detailSummary = findBlocks(details.json.tree.root.main, "section").find(
			(one) => one.id === "job-summary",
		);
		const offered = (detailSummary?.actions ?? []).map((one: any) => one.id);
		expect(offered).toEqual(["run-now", "reset-state", "job-edit", "job-delete"]);
		const editButton = detailSummary?.actions.find((one: any) => one.id === "job-edit");
		expect(editButton?.action).toEqual({
			type: "navigate",
			params: { job: job.id, edit: true },
		});
		const deleteButton = detailSummary?.actions.find((one: any) => one.id === "job-delete");
		expect(deleteButton?.action).toEqual({
			type: "submit",
			name: "deleteJob",
			confirm: {
				title: "Delete this job?",
				body: "Its run history is kept.",
				tone: "bad",
			},
		});
		assertActionBlocksValid(details.json.tree.root);

		// A declared job in edit mode renders the DETAILS, not the form.
		const declared = await view(app, alice, { job: "file:acme-file", edit: true });
		expect(declared.status).toBe(200);
		expect(findBlock(declared.json.tree.root.main, "form")).toBeUndefined();
		const declaredMain = atPointer(declared.json.data, "/main") as Record<string, any>;
		expect(declaredMain.found).toBe(true);
		expect(declaredMain.job?.id).toBe("file:acme-file");
	});

	test("deleteJob retires the job; the list no longer shows it", async () => {
		const { app, alice } = await bootServer();
		const job = await createJob(app, alice, promptSpec("acme-nightly"));
		expect((await view(app, alice, { job: job.id })).status).toBe(200);
		const deleted = await act(app, alice, "deleteJob", null, { job: job.id });
		expect(deleted.status).toBe(200);
		expect(deleted.json.ok).toBe(true);
		expect(deleted.json.navigate).toEqual({ type: "navigate", params: {} });
		const fetched = await call(app, "GET", `/v1/jobs/${job.id}`, alice);
		expect(fetched.status).toBe(404);
		const list = await view(app, alice);
		const ids = (atPointer(list.json.data, "/jobs") as any[]).map((row) => row.id);
		expect(ids).not.toContain(job.id);
	});

	test("read access: no edit buttons, handlers forbidden", async () => {
		const { app, alice, bob } = await bootServer();
		const job = await createJob(
			app,
			alice,
			promptSpec("acme-nightly", {
				sharing: { scope: "household", level: "read" },
			}),
		);
		// The reader's tree carries no edit/delete affordances.
		const readers = await view(app, bob, { job: job.id });
		expect(readers.status).toBe(200);
		const actionIds = collectActionIds(readers.json.tree.root);
		expect(actionIds).not.toContain("job-edit");
		expect(actionIds).not.toContain("job-delete");
		// Read access in edit mode renders the details, not the form.
		const editView = await view(app, bob, { job: job.id, edit: true });
		expect(findBlock(editView.json.tree.root.main, "form")).toBeUndefined();
		// The handlers answer forbidden (the job-level write rule).
		const saved = await act(
			app,
			bob,
			"saveJob",
			{ values: { name: "acme-stolen" } },
			{ job: job.id, edit: true },
		);
		expect(saved.json).toEqual({ ok: false, error: { message: "forbidden" } });
		const deleted = await act(app, bob, "deleteJob", null, { job: job.id });
		expect(deleted.json).toEqual({ ok: false, error: { message: "forbidden" } });
	});

	test("declared jobs refuse save and delete", async () => {
		const { app, alice } = await bootServer({
			settings: {
				jobs: [{ ...promptSpec("acme-file"), owner: "alice" }],
			},
		});
		expect((await view(app, alice, { job: "file:acme-file" })).status).toBe(200);
		const saved = await act(
			app,
			alice,
			"saveJob",
			{ values: { name: "acme-changed" } },
			{ job: "file:acme-file", edit: true },
		);
		expect(saved.json).toEqual({
			ok: false,
			error: { message: "job_declared" },
		});
		const deleted = await act(app, alice, "deleteJob", null, { job: "file:acme-file" });
		expect(deleted.json).toEqual({
			ok: false,
			error: { message: "job_declared" },
		});
		// No change landed.
		const fetched = await call(app, "GET", "/v1/jobs/file:acme-file", alice);
		expect(fetched.status).toBe(200);
		expect(fetched.json.job.name).toBe("acme-file");
	});
});
