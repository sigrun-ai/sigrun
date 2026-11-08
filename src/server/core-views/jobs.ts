/**
 * The `core/jobs` view (tabs+skills Task 5): the jobs surface as a
 * core blocks view — the JobsPanel's data, re-cast data-bound so the
 * Task 4 bump contract (`job.changed → bumpAllInstances("core",
 * "jobs")`) refreshes clients WITHOUT a new tree. Every row the tree
 * shows binds `{$: ...}` against the `data()` document; nothing job-
 * specific is inlined at render time (an inlined row could never
 * refresh — `bumpAllInstances` advances `rev` only).
 *
 * - The SIDEBAR is a `collection` bound to `/jobs` — the caller-
 *   visible rows (the shared `jobs-access.ts` rule, so this view and
 *   `GET /v1/jobs` always agree): name, schedule summary, next run,
 *   last outcome (JobsPanel parity). `onActivate` navigates
 *   `{job: id}`; compact widths drill in through the page's
 *   `selection` (Task 3).
 * - MAIN holds the selected job: a summary, the runs (newest
 *   {@link PAGE_SIZE}, *Load more* → `runCursor`) and the revisions
 *   (paged the same by `revCursor`). A run with a conversation carries
 *   a `navigate {target: {conversation}}` button (a LITERAL per page —
 *   navigate params are JSON, never bindings, and data can never ride
 *   into them). `?params={job, revision}` selects one revision: only
 *   it shows a `diff` block of its spec JSON against the previous
 *   revision's (the JobsPanel before/after rule, per-page literals for
 *   the same navigate-params reason).
 * - `runNow`/`resetState` need WRITE access: the buttons never render
 *   for a read caller and the handlers answer the `{forbidden}` action
 *   error (mirroring the routes' 403). Access `none` hides the job
 *   (absent from the sidebar; an unknown or hidden `job` param renders
 *   the list with the main empty state "Job not found"). An anonymous
 *   principal has no view at all (`access: "none"` — the surface
 *   route's 404).
 */

import type { Access, AccessPrincipal } from "@sigrun/shared/access";
import type { JsonObject, Tree } from "@sigrun/shared/blocks";
import type {
	JobRevisionWire,
	JobRunWire,
	JobSchedule,
	JobWire,
} from "@sigrun/shared/jobs";
import type {
	ActionResult,
	Principal,
	SurfaceContext,
	SurfaceDef,
	SurfaceRenderResult,
} from "../../extension.js";
import type { JobsService } from "../../jobs/index.js";
import {
	JobDeclaredError,
	JobNotFoundError,
} from "../../jobs/index.js";
import { jobAccess } from "../jobs-access.js";
import { isSuperuser } from "../auth/principal.js";
import {
	createSpecOf,
	emptyForm,
	formFromJob,
	formValuesOf,
	jobFormFields,
	savePatchOf,
	type JobFormData,
} from "./jobs-form.js";

/** The runs page size and the revisions page size (the plan refinement). */
export const PAGE_SIZE = 25;

/** One sidebar row (the JobsPanel summary line). */
interface JobRow {
	readonly id: string;
	readonly name: string;
	readonly description: string | null;
	readonly scheduleSummary: string;
	readonly nextRun: string | null;
	readonly lastOutcome: string | null;
	readonly lastError: string | null;
}

/** One run card row. */
interface RunRow {
	readonly id: string;
	readonly at: string;
	readonly version: number;
	readonly manual: boolean;
	readonly outcome: string;
	readonly error: string | null;
	readonly conversationId?: number;
}

/** One revision card row (JobsPanel parity: version/changedAt/changedBy).
 *  The `id` IS the version as a string: the collection's {itemId}
 *  activation (openRevision) derives from it (whole-branch review I1). */
interface RevisionRow {
	readonly id: string;
	readonly version: number;
	readonly changedAt: string;
	readonly changedBy: string;
	readonly enabled: boolean;
}

/** The selected job's header summary. */
interface JobHeader {
	readonly id: string;
	readonly name: string;
	readonly description: string | null;
	/** The provenance line ({@link definedInOf}). */
	readonly definedIn: string;
	readonly owner: string | null;
	readonly source: "api" | "file" | "extension";
	readonly kind: "prompt" | "task";
	// Prompt-action fields (null on a task job).
	readonly prompt: string | null;
	readonly model: string | null;
	readonly thinking: string | null;
	readonly conversation: string | null;
	readonly deliver: string | null;
	// Task-action fields (null on a prompt job).
	readonly task: string | null;
	readonly taskInputMarkdown: string | null;
	readonly scheduleSummary: string;
	readonly nextRun: string | null;
	readonly lastOutcome: string | null;
	readonly lastError: string | null;
	readonly state: string;
	readonly enabled: boolean;
	readonly version: number;
	readonly access: "read" | "write";
}

/** One selected revision's diff (per-page literals). */
interface SelectedDiff {
	readonly version: number;
	readonly before: string;
	readonly after: string;
}

/** The `/main` data branch for a selected job (mutable while built). */
interface MainData {
	found: boolean;
	job: JobHeader | null;
	runs: {
		items: readonly RunRow[];
		hasMore: boolean;
		nextRunCursor: string | null;
	};
	revisions: {
		items: readonly RevisionRow[];
		hasMore: boolean;
		nextRevCursor: number | null;
	};
}

/** One model picker option (Default first, id "default"). */
interface ModelOption {
	readonly id: string;
	readonly label: string;
}

/** The whole data document the tree binds against. */
interface JobsViewData {
	readonly jobs: readonly JobRow[];
	readonly main: MainData;
	/** The New job form's seeded values (bind target `/form`). */
	readonly form: JobFormData;
	/** The model choice's options (the `{$: "/modelOptions"}` binding). */
	readonly modelOptions: readonly ModelOption[];
}

/** The view's params (spec §7.3: JSON, size-capped by the route). */
interface JobsViewParams {
	readonly job?: string;
	readonly revision?: number;
	readonly revCursor?: number;
	readonly runCursor?: string;
	/** New-job form (jobs-editor Task 3): the form branch of the main column. */
	readonly edit?: true;
}

/** A schedule's summary text (the JobsPanel rule, verbatim). */
function scheduleSummary(schedule: JobSchedule): string {
	if ("cron" in schedule) {
		return schedule.timezone === undefined
			? schedule.cron
			: `${schedule.cron} (${schedule.timezone})`;
	}
	if ("every" in schedule) return `every ${schedule.every}`;
	return `at ${schedule.at}`;
}

/**
 * The provenance line for one job, derived from its id (the id prefix IS
 * the source). Exported for the view's tests (jobs-editor Task 2).
 */
export function definedInOf(id: string, source: JobWire["source"]): string {
	if (source === "file") {
		return `settings.json (jobs → ${id.slice("file:".length)})`;
	}
	if (source === "extension") {
		return `the ${extensionSlugOf(id)} extension`;
	}
	return "created in sigrun";
}

/** The declaring extension's slug (`ext:<slug>:<name>` — the middle). */
function extensionSlugOf(id: string): string {
	return id.slice("ext:".length).split(":")[0];
}

/** One job's sidebar/header summary fields. */
function summaryFields(row: Omit<JobWire, "access">): {
	readonly scheduleSummary: string;
	readonly nextRun: string | null;
	readonly lastOutcome: string | null;
	readonly lastError: string | null;
} {
	return {
		scheduleSummary: scheduleSummary(row.schedule),
		nextRun: row.nextRun ?? null,
		lastOutcome: row.lastRun?.outcome ?? null,
		lastError: row.lastError ?? row.lastRun?.error ?? null,
	};
}

/** Whether `payload` (an action's JSON argument) is a plain object. */
function isObject(payload: unknown): payload is Record<string, unknown> {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

/** The `{jobId}` a runNow/resetState dispatch carries. Channel caveat
 * (tabs+skills Task 6 e2e find): a plain callout button dispatches with
 * a NULL payload on BOTH channels (webui ActionButtonRow and the tui's
 * runAction pass `null` — the {itemId} convention covers only a
 * collection ACTIVATION), so the handlers resolve the job from the
 * instance params (`params.job`) — the surface is principal-scoped, so
 * the params ARE the instance key and one selected job never serves
 * another's fire. The payload `{jobId}` stays accepted (an explicit
 * override, e.g. a future per-row button), params take the fallback. */
function jobIdOf(payload: unknown): string | undefined {
	if (!isObject(payload)) return undefined;
	const jobId = payload.jobId;
	return typeof jobId === "string" && jobId !== "" ? jobId : undefined;
}

/** The `{itemId}` an `onActivate` (collection row activation) dispatch carries. */
function itemIdOf(payload: unknown): string | undefined {
	if (!isObject(payload)) return undefined;
	const itemId = payload.itemId;
	return typeof itemId === "string" && itemId !== "" ? itemId : undefined;
}

/** Parse the instance params (loose JSON → the typed shape; bad types drop). */
function paramsOf(params: JsonObject): JobsViewParams {
	const out: {
		job?: string;
		revision?: number;
		revCursor?: number;
		runCursor?: string;
		edit?: true;
	} = {};
	if (params.edit === true) out.edit = true;
	if (typeof params.job === "string" && params.job !== "") out.job = params.job;
	if (Number.isInteger(params.revision) && (params.revision as number) > 0) {
		out.revision = params.revision as number;
	}
	if (Number.isInteger(params.revCursor) && (params.revCursor as number) > 0) {
		out.revCursor = params.revCursor as number;
	}
	if (typeof params.runCursor === "string" && params.runCursor !== "") {
		out.runCursor = params.runCursor;
	}
	return out;
}

/** One run's stable cursor + row id (fireAt is the run's unique key). */
function runKey(run: JobRunWire): string {
	return `${run.jobId}:${run.fireAt}`;
}

/** The run row (the JobsPanel run line: when, version, manual, outcome, error). */
function runRow(run: JobRunWire): RunRow {
	return {
		id: runKey(run),
		at: run.fireAt,
		version: run.version,
		manual: run.manual,
		outcome: run.outcome,
		error: run.error ?? null,
		...(run.conversationId === null || run.conversationId === undefined
			? {}
			: { conversationId: run.conversationId }),
	};
}

/** The revision row (version, changedAt, changedBy). */
function revisionRow(revision: JobRevisionWire): RevisionRow {
	return {
		id: String(revision.version),
		version: revision.version,
		changedAt: revision.changedAt,
		changedBy: revision.changedBy,
		enabled: revision.enabled,
	};
}

/** The pretty-printed spec JSON the diff panes show (the JobsPanel print). */
function specJson(revision: JobRevisionWire): string {
	return JSON.stringify(revision.spec, null, 2);
}

/**
 * Build the view's data document for one caller. The `job` header,
 * runs and revisions only resolve when the caller can SEE the job —
 * otherwise `found: false` (the main empty state), exactly the list's
 * absence rule.
 */
async function readData(
	jobs: JobsService,
	principal: AccessPrincipal,
	params: JobsViewParams,
	models: () => readonly ModelOption[],
): Promise<JobsViewData> {
	const rows: JobRow[] = [];
	let selected: (Omit<JobWire, "access"> & { access: Access }) | undefined;
	for (const wire of await jobs.list()) {
		const { access: _stamped, ...row } = wire;
		const access = jobAccess(principal, row);
		if (access === "none") continue;
		rows.push({
			id: row.id,
			name: row.name,
			description: row.description ?? null,
			...summaryFields(row),
		});
		if (params.job !== undefined && row.id === params.job) {
			selected = { ...row, access };
		}
	}

	const main: MainData = {
		found: false,
		job: null,
		runs: { items: [], hasMore: false, nextRunCursor: null },
		revisions: { items: [], hasMore: false, nextRevCursor: null },
	};
	if (selected === undefined)
		return { jobs: rows, main, form: emptyForm(), modelOptions: models() };

	// The Task 4 edit seed: `{job, edit}` on a WRITABLE api job seeds
	// `/form` from the job's current spec (a declared or read job in edit
	// mode renders the details instead — the details keep the plain
	// empty form, which the tree never shows there).
	const form: JobFormData =
		params.edit === true &&
		selected.source === "api" &&
		selected.access === "write"
			? formFromJob(selected)
			: emptyForm();

	// Runs: newest first; the cursor IS a run key (opaque to clients).
	// The service's list is bounded by the retention cap, so the view
	// fetches it whole and pages in memory.
	const allRuns = await jobs.runs(selected.id, Number.MAX_SAFE_INTEGER);
	const runStart =
		params.runCursor === undefined
			? 0
			: Math.max(
					0,
					allRuns.findIndex((run) => runKey(run) === params.runCursor),
				);
	const runPage = allRuns.slice(runStart, runStart + PAGE_SIZE);
	const nextRun = allRuns[runStart + PAGE_SIZE];
	main.runs = {
		items: runPage.map(runRow),
		hasMore: nextRun !== undefined,
		nextRunCursor: nextRun === undefined ? null : runKey(nextRun),
	};

	// Revisions: newest first, paged by PAGE_SIZE with a plain offset cursor.
	const allRevisions = await jobs.revisions(selected.id);
	const revStart = params.revCursor ?? 0;
	const revPage = allRevisions.slice(revStart, revStart + PAGE_SIZE);
	const nextRev = revStart + PAGE_SIZE;
	main.revisions = {
		items: revPage.map(revisionRow),
		hasMore: nextRev < allRevisions.length,
		nextRevCursor: nextRev < allRevisions.length ? nextRev : null,
	};

	main.found = true;
	const action = selected.action;
	main.job = {
		id: selected.id,
		name: selected.name,
		description: selected.description ?? null,
		definedIn: definedInOf(selected.id, selected.source),
		owner: selected.owner ?? null,
		source: selected.source,
		kind: action.kind,
		prompt: action.kind === "prompt" ? action.prompt : null,
		model: action.kind === "prompt" ? (action.model ?? null) : null,
		thinking: action.kind === "prompt" ? (action.thinking ?? null) : null,
		conversation:
			action.kind === "prompt"
				? action.conversation === "new"
					? "new"
					: `#${action.conversation}`
				: null,
		deliver:
			action.kind === "prompt" && action.deliver !== undefined
				? action.deliver.join(", ")
				: null,
		task: action.kind === "task" ? action.task : null,
		taskInputMarkdown:
			action.kind === "task" && action.input !== undefined
				? `\`\`\`json\n${JSON.stringify(action.input, null, 2)}\n\`\`\``
				: null,
		...summaryFields(selected),
		state: selected.state,
		enabled: selected.enabled,
		version: selected.version,
		// `none` is impossible here (selected came from the visible list);
		// the fallback only satisfies the narrowing.
		access: selected.access === "none" ? "read" : selected.access,
	};
	return { jobs: rows, main, form, modelOptions: models() };
}

/** The one revision selected for the diff, plus its previous (baseline). */
function selectDiff(
	revisions: readonly JobRevisionWire[],
	page: readonly JobRevisionWire[],
	version: number | undefined,
): SelectedDiff | undefined {
	if (version === undefined) return undefined;
	const index = page.findIndex((revision) => revision.version === version);
	if (index === -1) return undefined;
	const selected = page[index];
	const previous = page[index + 1] ?? revisions[revisions.indexOf(selected) + 1];
	if (previous === undefined) return undefined;
	return { version, before: specJson(previous), after: specJson(selected) };
}

/** The view surface (`SurfaceDef<"view">`), built over the jobs service. */
export function createJobsView(deps: {
	jobs: JobsService;
	now(): Date;
	/** The model catalog as picker entries (jobs-editor Task 3):
	 *  `listModels` over the opened harness, projected to id+label. */
	models(): readonly ModelOption[];
	/** The directory-aware principal (groups included), wired in
	 *  src/server/index.ts as `(p) => accessPrincipalOf(p,
	 *  opened.identity.users)` — the same projection the routes use. */
	accessPrincipal(principal: Principal): AccessPrincipal;
}): SurfaceDef<"view"> {
	const { jobs } = deps;
	/** The model options: Default first (id "default"), then the
	 *  catalog rows (id is the full `provider/modelId`). */
	const modelOptions = (): readonly ModelOption[] => [
		{ id: "default", label: "Default" },
		...deps.models(),
	];

	/** The caller's directory-aware principal (undefined user = anonymous).
	 *  Whole-branch review I3: the USERLESS SUPERUSER (the naive
	 *  single-operator loopback principal) is admitted — the /v1/jobs
	 *  routes grant it write, and the view is parity (the access rule's
	 *  superuser clause answers write for every row). */
	const callerOf = (ctx: SurfaceContext): AccessPrincipal | undefined => {
		if (ctx.principal.user === undefined && !isSuperuser(ctx.principal)) {
			return undefined;
		}
		return deps.accessPrincipal(ctx.principal);
	};

	/** The tree's shared, data-bound skeleton (params/access independent). */
	const baseTree = (): {
		v: 1;
		root: {
			type: "page";
			id: "jobs-root";
			title: "Jobs";
			sidebar: Record<string, unknown>[];
			main: Record<string, unknown>[];
		};
	} => ({
		v: 1,
		root: {
			type: "page",
			id: "jobs-root",
			title: "Jobs",
			sidebar: [
				{
					type: "collection",
					id: "jobs",
					display: "list",
					items: { $: "/jobs" },
					// Per-row drill-in (review Critical 2): a `navigate`
					// onActivate could never carry the ACTIVATED row's id
					// (navigate params are static literals; the {itemId}
					// payload is shell-dropped for view-only actions). An
					// `edit` activation instead dispatches {itemId} to the
					// `openJob` handler — the curator view's shape — whose
					// accepted result carries `navigate` back through the
					// wire (§6.3). Gate note: `edit` is not view-only, so the
					// channels require surface access "write" to dispatch it
					// (webui rows.tsx useActivate) — this view always returns
					// "write" for an identified caller (the action rule is
					// per-job, enforced in the handlers), so the gate passes.
					onActivate: { type: "edit", name: "openJob" },
					item: {
						title: { $: "./name" },
						subtitle: { $: "./description" },
						meta: [
							{ text: { $: "./scheduleSummary" }, icon: "clock" },
							{ text: { $: "./nextRun" }, icon: "clock" },
							{ text: { $: "./lastOutcome" }, icon: "info" },
						],
					},
				},
			],
			main: [
				{
					type: "collection",
					id: "main-empty",
					display: "list",
					items: { $: "/main/runs/items" },
					item: { title: { $: "./at" } },
				},
			],
		},
	});

	/** The anonymous/none-access tree (an empty page; the route 404s it). */
	const noneTree = (): Tree =>
		// SAFETY: the tree object is a JSON literal built here; `Tree`'s
		// interfaces lack the index signature the wire type requires, so
		// the cast only restores that erased identity.
		({
			v: 1,
			root: {
				type: "page",
				id: "jobs-root",
				title: "Jobs",
				main: [{ type: "markdown", text: "Sign in to see jobs." }],
			},
		}) as unknown as Tree;

	/** The full tree for one resolved page (params + access + diff). */
	const buildTree = (
		params: JobsViewParams,
		data: JobsViewData,
		diff: SelectedDiff | undefined,
	): Tree => {
		const tree = baseTree();
		// Blocks are built as loose JSON objects (the validator owns the
		// wire shape; the service validates every tree before serving).
		const main: Record<string, unknown>[] = [];
		// `{edit: true}` alone is the New-job form; `{job, edit}` edits THAT
		// job. A declared (file:/ext:) or read-access job in edit mode falls
		// through to the DETAILS (the editor is api+write only); an unknown
		// `job` param with edit keeps the Task 3 rule (the form wins over
		// "Job not found") only when NO job is selected.
		const editingJob =
			params.edit === true &&
			params.job !== undefined &&
			data.main.found &&
			data.main.job !== null &&
			data.main.job.source === "api" &&
			data.main.job.access === "write";
		if (params.edit === true && (params.job === undefined || editingJob)) {
			main.push({
				type: "form",
				id: "job-form",
				bind: "/form",
				mode: "submit",
				onSubmit: editingJob ? "saveJob" : "createJob",
				submitLabel: editingJob ? "Save" : "Create",
				children: jobFormFields(
					editingJob && data.main.job !== null ? data.main.job.kind : "prompt",
				),
			});
		} else if (data.main.found && data.main.job !== null) {
			const job = data.main.job;
			// One bound card action serves every run; rows without a
			// conversation resolve it away and show no button.
			const runButtons: Record<string, unknown>[] = [
				{
					id: "conversation",
					label: "Conversation",
					icon: "link",
					action: {
						type: "navigate",
						target: { conversation: { $: "./conversationId" } },
					},
				},
			];
			const writeActions: Record<string, unknown>[] =
				job.access === "write"
					? [
							{
								id: "run-now",
								label: "Run now",
								icon: "refresh",
								action: { type: "submit", name: "runNow" },
							},
							{
								id: "reset-state",
								label: "Reset state",
								icon: "delete",
								action: {
									type: "submit",
									name: "resetState",
									confirm: {
										title: "Reset state?",
										body: "Reset this job's state? Its state folder is emptied.",
									},
								},
							},
							// Edit/Delete are api-only (declared jobs are read-only
							// declarations — the `job-declared` callout says where to
							// edit them). The confirm copy promises the run history
							// survives (deleteApi retires the record; history routes
							// answer for retired ids).
							...(job.source === "api"
								? [
										{
											id: "job-edit",
											label: "Edit",
											icon: "edit",
											action: {
												type: "navigate",
												params: { job: job.id, edit: true },
											},
										},
										{
											id: "job-delete",
											label: "Delete",
											icon: "delete",
											action: {
												type: "submit",
												name: "deleteJob",
												confirm: {
													title: "Delete this job?",
													body: "Its run history is kept.",
													tone: "bad",
												},
											},
										},
									]
								: []),
						]
					: [];

				main.push(
				{
					type: "section",
					id: "job-summary",
					title: { $: "/main/job/name" },
					actions: writeActions,
					children: [
						{
							type: "fields",
							hideEmpty: true,
							rows: [
								{ label: "Description", value: { $: "/main/job/description" } },
								{ label: "Defined in", value: { $: "/main/job/definedIn" } },
								{ label: "Owner", value: { $: "/main/job/owner" } },
								{ label: "Schedule", value: { $: "/main/job/scheduleSummary" } },
								{ label: "Next run", value: { $: "/main/job/nextRun" } },
								{ label: "Last outcome", value: { $: "/main/job/lastOutcome" } },
								{ label: "Last error", value: { $: "/main/job/lastError" } },
								{ label: "State", value: { $: "/main/job/state" } },
								{ label: "Version", value: { $: "/main/job/version" } },
								{ label: "Model", value: { $: "/main/job/model" } },
								{ label: "Thinking", value: { $: "/main/job/thinking" } },
								{ label: "Conversation", value: { $: "/main/job/conversation" } },
								{ label: "Deliver", value: { $: "/main/job/deliver" } },
								{ label: "Task", value: { $: "/main/job/task" } },
							],
						},
					],
				},
				{
					type: "section",
					id: "job-prompt",
					title: "Prompt",
					children: [
						// The action body blocks: BOTH are emitted UNCONDITIONALLY.
						// The earlier kind-conditional form rested on a false invariant —
						// `bumpRev` advances `rev` only (treeRev is never written), so a
						// REST PATCH that changes a job's action kind would leave an open
						// client showing the stale body block until reload (the clients
						// apply fresh DATA to the SAME tree). The data-bound fix is
						// unconditional blocks: the off-kind binding resolves null, and
						// both clients render a null/empty markdown text as NOTHING
						// visible (webui boundString → "" in a zero-height div; pi-tui
						// Markdown returns zero lines for empty text).
						{ type: "markdown", text: { $: "/main/job/prompt" } },
						{ type: "markdown", text: { $: "/main/job/taskInputMarkdown" } },
					],
				},
				// Declared jobs (file:/ext:) are READ-ONLY declarations: no edit
				// affordances here (the editor, Tasks 3-4, is api-only) — a
				// callout points the user at the declaring source instead.
				...(job.source === "api"
					? []
					: [
							{
								type: "callout",
								id: "job-declared",
								tone: "neutral",
								title:
									job.source === "file"
										? "Defined in settings.json — edit it there"
										: `Declared by the ${extensionSlugOf(job.id)} extension`,
							},
						]),
				{
					type: "section",
					id: "job-runs",
					title: "Runs",
					children: [
						{
							type: "collection",
							id: "runs",
							display: "list",
							items: { $: "/main/runs/items" },
							item: {
								title: { $: "./at" },
								subtitle: { $: "./outcome" },
								body: { $: "./error" },
								badges: [{ text: { $: "./manual" }, tone: "neutral" }],
								actions: runButtons,
							},
						},
					],
				},
				...(data.main.runs.hasMore && data.main.runs.nextRunCursor !== null
					? [
							{
								type: "callout",
								id: "runs-more",
								tone: "neutral",
								title: "More runs",
								actions: [
									{
										id: "runs-more-load",
										label: "Load more",
										icon: "more",
										action: {
											type: "navigate",
											params: {
												job: job.id,
												runCursor: data.main.runs.nextRunCursor,
											},
										},
									},
								],
							},
						]
					: []),
				{
					type: "section",
					id: "job-revisions",
					title: "Revisions",
					children: [
						{
							type: "collection",
							id: "revisions",
							display: "list",
							items: { $: "/main/revisions/items" },
							// Per-row drill-in (the sidebar's openJob pattern,
							// whole-branch review I1): a static `navigate` could
							// only re-navigate to the ALREADY-selected revision —
							// the diff would be unreachable by clicking. The
							// `edit` activation carries {itemId} (the row's id,
							// the revision VERSION) to `openRevision`, whose
							// accepted result carries {job, revision} back (§6.3).
							onActivate: { type: "edit", name: "openRevision" },
							item: {
								title: { $: "./version" },
								subtitle: { $: "./changedBy" },
								meta: [{ time: { $: "./changedAt" }, format: "relative" }],
							},
						},
					],
				},
				...(data.main.revisions.hasMore &&
					data.main.revisions.nextRevCursor !== null
					? [
							{
								type: "callout",
								id: "revisions-more",
								tone: "neutral",
								title: "More revisions",
								actions: [
									{
										id: "revisions-more-load",
										label: "Load more",
										icon: "more",
										action: {
											type: "navigate",
											params: {
												job: job.id,
												revCursor: data.main.revisions.nextRevCursor,
											},
										},
									},
								],
							},
						]
					: []),
			);
			if (diff !== undefined) {
				main.push({
					type: "section",
					id: "revision-diff",
					title: `Revision ${diff.version}`,
					children: [
						{
							type: "diff",
							id: "diff",
							before: diff.before,
							after: diff.after,
							lang: "json",
						},
					],
				});
			}
		} else {
			main.push({
				type: "section",
				id: "job-empty",
				children: [{ type: "markdown", text: "Job not found" }],
			});
		}
		tree.root.main = main;
		// SAFETY: the tree object is a JSON literal built here; `Tree`'s
		// interfaces lack the index signature the wire type requires, so
		// the cast only restores that erased identity.
		return {
			...tree,
			root: {
				...tree.root,
				// The New job affordance renders for ANY identified caller
				// (createJob admits via callerOf; the form itself is inert).
				actions: [
					{
						id: "job-new",
						label: "New job",
						icon: "add",
						action: { type: "navigate", params: { edit: true } },
					},
				],
				selection: {
					selected: params.job !== undefined || params.edit === true,
					back: {},
				},
				...(data.main.found || params.edit === true
					? {}
					: {
							empty: {
								icon: "clock",
								title: "Job not found",
							},
						}),
			},
		} as unknown as Tree;
	};

	/** Resolve one caller's access to one job id for an action. */
	const actionAccess = async (
		ctx: SurfaceContext,
		jobId: string,
	): Promise<{ row: Omit<JobWire, "access">; access: Access } | { error: ActionResult }> => {
		const caller = callerOf(ctx);
		if (caller === undefined) {
			return { error: { ok: false, error: { message: "forbidden" } } };
		}
		const wire = await jobs.get(jobId);
		if (wire === undefined) {
			return { error: { ok: false, error: { message: "job_not_found" } } };
		}
		const { access: _stamped, ...row } = wire;
		const access = jobAccess(caller, row);
		if (access === "none") {
			return { error: { ok: false, error: { message: "job_not_found" } } };
		}
		if (access === "read") {
			return { error: { ok: false, error: { message: "forbidden" } } };
		}
		return { row, access };
	};

	return {
		id: "jobs",
		title: "Jobs",
		icon: "clock",
		placement: "view",
		// A principal-owned surface (§7.3): the principal folds into the
		// instance identity so two users' views are two instances.
		instanceKey: (params, principal) =>
			JSON.stringify([principal.user ?? "", params]),
		render: async (ctx: SurfaceContext) => {
			const caller = callerOf(ctx);
			if (caller === undefined) {
				return { tree: noneTree(), data: {}, access: "none" };
			}
			const params = paramsOf(ctx.params);
			const data = await readData(jobs, caller, params, modelOptions);
			const revisions =
				params.job === undefined || !data.main.found
					? []
					: await jobs.revisions(params.job);
			const revStart = params.revCursor ?? 0;
			const page = revisions.slice(revStart, revStart + PAGE_SIZE);
			const diff = selectDiff(revisions, page, params.revision);
			return {
				tree: buildTree(params, data, diff),
				// SAFETY: the data document is a JSON mirror (every field a
				// literal); the interface lacks the index signature JsonObject
				// requires, so the cast only restores that erased identity.
				data: data as unknown as SurfaceRenderResult["data"],
				// The surface access is ALWAYS "write" for an identified
				// caller: the §6.3 action route 403s read-verdict surfaces
				// outright, but this view's action rule is PER JOB (a caller
				// may write one listed job and only read another) — the
				// handlers enforce job-level write themselves. Read hiding
				// is tree-level (the buttons never render), like the §6.5
				// read rule's client half.
				access: "write",
			};
		},
		data: async (ctx: SurfaceContext) => {
			const caller = callerOf(ctx);
			if (caller === undefined) return { data: {}, access: "none" };
			const params = paramsOf(ctx.params);
			const data = await readData(jobs, caller, params, modelOptions);
			return {
				// SAFETY: same JSON-mirror cast as `render`'s (the comment there).
				data: data as unknown as SurfaceRenderResult["data"],
				access: "write",
			};
		},
		actions: {
			// The New job form's submit (jobs-editor Task 3): callerOf
			// admission (anonymous non-superuser → forbidden; the userless
			// superuser creates with an undefined owner, matching
			// POST /v1/jobs), then the form-owned spec assembly. Field
			// errors come back field-scoped so the channels mark the field.
			createJob: async (
				ctx: SurfaceContext,
				payload: unknown,
			): Promise<ActionResult> => {
				const caller = callerOf(ctx);
				if (caller === undefined) {
					return { ok: false, error: { message: "forbidden" } };
				}
				const assembled = createSpecOf(formValuesOf(payload));
				if (!assembled.ok) {
					return {
						ok: false,
						error: { message: assembled.message, field: assembled.field },
					};
				}
				let created;
				try {
					created = await jobs.createApi(assembled.spec, caller.user);
				} catch (error) {
					return {
						ok: false,
						error: {
							message: error instanceof Error ? error.message : String(error),
						},
					};
				}
				return {
					ok: true,
					toast: `Created ${assembled.spec.name}`,
					navigate: { type: "navigate", params: { job: created.id } },
				};
			},
			// The sidebar row's drill-in (review Critical 2): the `edit`
			// activation carries {itemId} = the row's id — the JOB id, the
			// collection rows' own `id` field (the channels derive item ids
			// from it, spec §5.5) — and the accepted result carries the
			// navigate back (§6.3: SurfaceActOk.navigate passes the wire
			// unchanged). Both channels apply it: the webui's useSurface
			// routes result.navigate through onNavigate, and the TUI's
			// SurfaceState does the same (jobs-editor Task 7) — its
			// accepted-result branch fires onNavigate LAST, and the app's
			// wiring reopens the view with the params. The compact page's
			// Esc-back dispatch (tui/src/blocks/page.ts) is genuinely
			// routed through the same seam.
			openJob: async (
				ctx: SurfaceContext,
				payload: unknown,
			): Promise<ActionResult> => {
				// Same admission as callerOf (review I3's P1 remainder):
				// anonymous → forbidden; the userless superuser is admitted.
				if (callerOf(ctx) === undefined) {
					return { ok: false, error: { message: "forbidden" } };
				}
				const jobId = itemIdOf(payload);
				if (jobId === undefined) {
					return { ok: false, error: { message: "openJob expects {itemId}" } };
				}
				return {
					ok: true,
					navigate: { type: "navigate", params: { job: jobId } },
				};
			},
			// A revision row's drill-in (whole-branch review I1): {itemId}
			// is the row's id = the revision VERSION; the current job rides
			// the instance params (the surface is principal-scoped, so the
			// params identify the selected job). The accepted result carries
			// {job, revision} back through the wire (§6.3), same as openJob.
			openRevision: async (
				ctx: SurfaceContext,
				payload: unknown,
			): Promise<ActionResult> => {
				if (callerOf(ctx) === undefined) {
					return { ok: false, error: { message: "forbidden" } };
				}
				const jobId = paramsOf(ctx.params).job;
				if (jobId === undefined) {
					return {
						ok: false,
						error: { message: "openRevision needs a selected job (params.job)" },
					};
				}
				const itemId = itemIdOf(payload);
				const revision = itemId === undefined ? NaN : Number(itemId);
				if (!Number.isInteger(revision) || revision <= 0) {
					return { ok: false, error: { message: "openRevision expects {itemId}" } };
				}
				return {
					ok: true,
					navigate: { type: "navigate", params: { job: jobId, revision } },
				};
			},
			// The Edit form's submit (jobs-editor Task 4): the job rides
			// the instance params (the surface is principal-scoped, so the
			// params identify the selected job — the same shape runNow
			// uses). The caller needs write access; a declared job is the
			// 409-class refusal; the patch rules live in savePatchOf.
			saveJob: async (
				ctx: SurfaceContext,
				payload: unknown,
			): Promise<ActionResult> => {
				const jobId = jobIdOf(payload) ?? paramsOf(ctx.params).job;
				if (jobId === undefined) {
					return {
						ok: false,
						error: { message: "saveJob needs a selected job (params.job)" },
					};
				}
				const resolved = await actionAccess(ctx, jobId);
				if ("error" in resolved) return resolved.error;
				if (resolved.row.source !== "api") {
					return { ok: false, error: { message: "job_declared" } };
				}
				const patched = savePatchOf(formValuesOf(payload), resolved.row);
				if (!patched.ok) {
					return {
						ok: false,
						error: { message: patched.message, field: patched.field },
					};
				}
				const caller = callerOf(ctx);
				try {
					await jobs.updateApi(
						jobId,
						patched.patch,
						caller?.user ?? "api",
					);
				} catch (error) {
					if (
						error instanceof JobDeclaredError ||
						error instanceof JobNotFoundError
					) {
						return { ok: false, error: { message: error.message } };
					}
					return {
						ok: false,
						error: {
							message: error instanceof Error ? error.message : String(error),
						},
					};
				}
				return {
					ok: true,
					toast: `Saved ${patched.patch.name ?? resolved.row.name}`,
					navigate: { type: "navigate", params: { job: jobId } },
				};
			},
			// Delete: write access, api-only, then the retired job leaves
			// the list — navigate back to the unselected view ({}).
			deleteJob: async (
				ctx: SurfaceContext,
				payload: unknown,
			): Promise<ActionResult> => {
				const jobId = jobIdOf(payload) ?? paramsOf(ctx.params).job;
				if (jobId === undefined) {
					return {
						ok: false,
						error: { message: "deleteJob needs a selected job (params.job)" },
					};
				}
				const resolved = await actionAccess(ctx, jobId);
				if ("error" in resolved) return resolved.error;
				if (resolved.row.source !== "api") {
					return { ok: false, error: { message: "job_declared" } };
				}
				const caller = callerOf(ctx);
				try {
					await jobs.deleteApi(jobId, caller?.user ?? "api");
				} catch (error) {
					if (
						error instanceof JobDeclaredError ||
						error instanceof JobNotFoundError
					) {
						return { ok: false, error: { message: error.message } };
					}
					return {
						ok: false,
						error: {
							message: error instanceof Error ? error.message : String(error),
						},
					};
				}
				return {
					ok: true,
					toast: `Deleted ${resolved.row.name}`,
					navigate: { type: "navigate", params: {} },
				};
			},
			runNow: async (
				ctx: SurfaceContext,
				payload: unknown,
			): Promise<ActionResult> => {
				const jobId = jobIdOf(payload) ?? paramsOf(ctx.params).job;
				if (jobId === undefined) {
					return {
						ok: false,
						error: { message: "runNow needs a selected job (params.job)" },
					};
				}
				const resolved = await actionAccess(ctx, jobId);
				if ("error" in resolved) return resolved.error;
				const fired = await jobs.runNow(jobId);
				return {
					ok: true,
					toast: `Run now: ${resolved.row.name} (${fired.outcome})`,
				};
			},
			resetState: async (
				ctx: SurfaceContext,
				payload: unknown,
			): Promise<ActionResult> => {
				const jobId = jobIdOf(payload) ?? paramsOf(ctx.params).job;
				if (jobId === undefined) {
					return {
						ok: false,
						error: { message: "resetState needs a selected job (params.job)" },
					};
				}
				const resolved = await actionAccess(ctx, jobId);
				if ("error" in resolved) return resolved.error;
				try {
					await jobs.resetState(jobId);
				} catch (error) {
					return {
						ok: false,
						error: {
							message: error instanceof Error ? error.message : String(error),
						},
					};
				}
				return { ok: true, toast: `Reset state: ${resolved.row.name}` };
			},
		},
	};
}
