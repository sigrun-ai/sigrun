/**
 * JobsPanel (W4 Task 5): the right-panel jobs tab — rows with name,
 * schedule, next run, last outcome and a link to the last run
 * conversation; "Run now" only for `access === "write"` jobs; expanding
 * a job shows its run history (newest first, with version + manual) and
 * its revision list (changedBy + the interaction diff primitive styling
 * for the JSON diff against the previous version). The refetch wiring:
 * App bumps `refreshToken` on `job.changed` (the shared `/v1/events`
 * source — ONE EventSource per app, owned by useConversationList).
 *
 * The stub fetch routes `/v1/jobs` (list), `POST …/run`, `…/runs`, and
 * `…/revisions` and records every call.
 */

import { act } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test, vi } from "vitest";
import {
	createClient,
	type FetchLike,
	type JobRevisionWire,
	type JobRunWire,
	type JobWire,
} from "../api";
import { findButton, renderAsync, textContent } from "../test-utils";
import { JobsPanel } from "./JobsPanel";

// ─── Wire fixtures (shared/src/jobs.ts shapes) ─────────────────────────────

function jobWire(
	fields: Partial<JobWire> & Pick<JobWire, "id" | "name">,
): JobWire {
	return {
		source: "api",
		schedule: { every: "15m" },
		action: {
			kind: "prompt",
			prompt: "Summarize the tide log",
			conversation: "new",
		},
		enabled: true,
		state: "waiting",
		version: 1,
		access: "write",
		...fields,
	};
}

function runWire(
	fields: Partial<JobRunWire> & Pick<JobRunWire, "fireAt">,
): JobRunWire {
	return {
		jobId: "api:morning-brief",
		version: 1,
		manual: false,
		outcome: "succeeded",
		startedAt: fields.fireAt,
		...fields,
	};
}

function revisionWire(
	fields: Partial<JobRevisionWire> & Pick<JobRevisionWire, "version">,
): JobRevisionWire {
	return {
		jobId: "api:morning-brief",
		source: "api",
		spec: {
			name: "morning-brief",
			schedule: { every: "15m" },
			action: {
				kind: "prompt",
				prompt: "Summarize the tide log",
				conversation: "new",
			},
		},
		enabled: true,
		changedAt: "2026-10-19T07:00:00.000Z",
		changedBy: "alice",
		...fields,
	};
}

const NEWER_FIRE = "2026-10-19T08:00:00.000Z";
const OLDER_FIRE = "2026-10-19T07:00:00.000Z";

const JOBS: JobWire[] = [
	jobWire({
		id: "api:morning-brief",
		name: "morning-brief",
		schedule: { cron: "0 7 * * *", timezone: "America/Toronto" },
		nextRun: NEWER_FIRE,
		lastRun: {
			jobId: "api:morning-brief",
			version: 1,
			fireAt: OLDER_FIRE,
			manual: false,
			outcome: "succeeded",
			startedAt: OLDER_FIRE,
			conversationId: 42,
		},
	}),
	jobWire({
		id: "file:nightly-sweep",
		name: "nightly-sweep",
		source: "file",
		schedule: { every: "15m" },
		access: "read",
		nextRun: OLDER_FIRE,
	}),
];

// The runs response is NEWEST FIRST (the server's contract) — the panel
// renders in wire order.
const RUNS: JobRunWire[] = [
	runWire({
		fireAt: NEWER_FIRE,
		version: 2,
		manual: true,
		outcome: "failed",
		error: "upstream 502",
		conversationId: 99,
	}),
	runWire({
		fireAt: OLDER_FIRE,
		version: 1,
		manual: false,
		outcome: "succeeded",
		conversationId: 42,
	}),
];

const REVISIONS: JobRevisionWire[] = [
	revisionWire({
		version: 2,
		changedBy: "bob",
		spec: {
			name: "morning-brief",
			schedule: { every: "30m" },
			action: {
				kind: "prompt",
				prompt: "Summarize the tide log",
				conversation: "new",
			},
		},
	}),
	revisionWire({ version: 1, changedBy: "alice" }),
];

// ─── The harness: fetch routing + call recording ───────────────────────────

function makeHarness() {
	const calls: { input: string; method: string }[] = [];
	const fetchImpl: FetchLike = (input, init) => {
		const method = init?.method ?? "GET";
		// The client encodes the `:` in job ids — route on the decoded form.
		const route = decodeURIComponent(input);
		calls.push({ input: route, method });
		let body: unknown;
		if (route === "/v1/jobs" && method === "GET") {
			body = { jobs: JOBS.map((job) => ({ ...job })) };
		} else if (route === "/v1/jobs/api:morning-brief/run" && method === "POST") {
			body = { outcome: "running", conversationId: 99 };
		} else if (route === "/v1/jobs/api:morning-brief/runs" && method === "GET") {
			body = { runs: RUNS.map((run) => ({ ...run })) };
		} else if (
			route === "/v1/jobs/api:morning-brief/revisions" &&
			method === "GET"
		) {
			body = { revisions: REVISIONS.map((rev) => ({ ...rev })) };
		} else {
			return Promise.reject(new Error(`unexpected fetch ${method} ${route}`));
		}
		return Promise.resolve({
			ok: true,
			status: 200,
			json: () => Promise.resolve(body),
			text: () => Promise.resolve(String(body)),
		});
	};
	return {
		client: createClient({ fetch: fetchImpl }) as SigrunClientLike,
		calls,
	};
}

type SigrunClientLike = ReturnType<
	typeof createClient
>;

/** Render the panel (async — effects fetch the list). */
async function renderPanel(
	harness: ReturnType<typeof makeHarness>,
	props: {
		readonly onNavigate?: (conversationId: number) => void;
		readonly refreshToken?: number;
	} = {},
): Promise<TestRenderer.ReactTestRenderer> {
	return await renderAsync(
		<JobsPanel
			client={harness.client}
			{...(props.onNavigate === undefined
				? {}
				: { onNavigate: props.onNavigate })}
			{...(props.refreshToken === undefined
				? {}
				: { refreshToken: props.refreshToken })}
		/>,
	);
}

/** Click a job's expand toggle (its summary row button). */
async function expand(
	renderer: TestRenderer.ReactTestRenderer,
	jobId: string,
): Promise<void> {
	const summary = renderer.root.find(
		(node: { props: Record<string, unknown> }) =>
			node.props["data-job-id"] === jobId,
	);
	await act(async () => {
		await (summary.props as { onClick: () => unknown }).onClick();
	});
}

describe("JobsPanel", () => {
	test("renders rows: name, schedule, next run, last outcome, and the last-run conversation link", async () => {
		const harness = makeHarness();
		const renderer = await renderPanel(harness);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("morning-brief");
		expect(text).toContain("nightly-sweep");
		// The schedule summary: cron + timezone, interval, or one-shot.
		expect(text).toContain("0 7 * * * (America/Toronto)");
		expect(text).toContain("every 15m");
		expect(text).toContain(NEWER_FIRE);
		expect(text).toContain("succeeded");
	});

	test("the last-run conversation link navigates to that conversation", async () => {
		const harness = makeHarness();
		const onNavigate = vi.fn();
		const renderer = await renderPanel(harness, { onNavigate });
		const link = renderer.root.findByProps({
			"aria-label": "open last run conversation",
		});
		await act(async () => {
			await link.props.onClick();
		});
		expect(onNavigate).toHaveBeenCalledWith(42);
	});

	test("Run now renders only for write access and POSTs the run route", async () => {
		const harness = makeHarness();
		const renderer = await renderPanel(harness);
		// Exactly one "Run now": the read-access job has none.
		expect(
			renderer.root.findAllByProps({ className: "job-runnow" }),
		).toHaveLength(1);
		const runNow = findButton(renderer, "Run now");
		await act(async () => {
			await runNow.props.onClick();
		});
		const runCall = harness.calls.find(
			(call) =>
				call.input === "/v1/jobs/api:morning-brief/run" && call.method === "POST",
		);
		expect(runCall).toBeDefined();
		// The outcome surfaces in the row (the fire answer, not silence).
		expect(textContent(renderer.toJSON())).toContain("running");
	});

	test("expanding shows runs newest first with version + manual + error, and revisions with changedBy and the diff styling", async () => {
		const harness = makeHarness();
		const renderer = await renderPanel(harness);
		await expand(renderer, "api:morning-brief");
		const text = textContent(renderer.toJSON());
		// Runs render in wire order (newest first): NEWER before OLDER.
		expect(text.indexOf(NEWER_FIRE)).toBeGreaterThanOrEqual(0);
		expect(text.indexOf(NEWER_FIRE)).toBeLessThan(text.indexOf(OLDER_FIRE));
		// Version + manual + outcome + error on the run rows.
		expect(text).toContain("v2");
		expect(text).toContain("manual");
		expect(text).toContain("upstream 502");
		// Revisions with changedBy.
		expect(text).toContain("bob");
		expect(text).toContain("alice");
		// The JSON diff against the previous version rides the interaction
		// diff primitive styling (before = previous spec, after = this one).
		const before = renderer.root.findAllByProps({
			className: "interaction-diff-before",
		});
		const after = renderer.root.findAllByProps({
			className: "interaction-diff-after",
		});
		expect(before).toHaveLength(1); // the newest revision diffs against v1
		expect(after).toHaveLength(1);
		expect(before[0]!.children.join("")).toContain('"every": "15m"');
		expect(after[0]!.children.join("")).toContain('"every": "30m"');
	});

	test("a run row's conversation link navigates to that run's conversation", async () => {
		const harness = makeHarness();
		const onNavigate = vi.fn();
		const renderer = await renderPanel(harness, { onNavigate });
		await expand(renderer, "api:morning-brief");
		const links = renderer.root.findAllByProps({
			"aria-label": "open run conversation",
		});
		expect(links).toHaveLength(2); // both runs carry a conversationId
		await act(async () => {
			await links[0]!.props.onClick();
		});
		expect(onNavigate).toHaveBeenCalledWith(99);
	});

	test("refetches the list when the job.changed refreshToken bumps (App wires the shared events source)", async () => {
		const harness = makeHarness();
		const renderer = await renderPanel(harness, { refreshToken: 0 });
		const listCalls = () =>
			harness.calls.filter((call) => call.input === "/v1/jobs").length;
		expect(listCalls()).toBe(1);
		await act(async () => {
			renderer.update(
				<JobsPanel client={harness.client} refreshToken={1} />,
			);
		});
		expect(listCalls()).toBe(2);
	});
});
