/**
 * The TUI `/jobs` slash command (W4 Task 5): `client.listJobs()` (GET
 * /v1/jobs) rendered as a table into the transcript pane's notice area —
 * one `[notice]` line per job (name, next run, last outcome), plus a
 * header/footer framing the list. Failure surfaces as the pane's error
 * line, never silence.
 */

import { describe, expect, test, vi } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";
import { TuiApp } from "../src/ui/app.js";
import {
	SigrunApiError,
	type ConversationList,
	type ConversationSummary,
	type ConversationViewWire,
	type JobWire,
	type SigrunClient,
} from "../src/api.js";
import type { Unwatch, WatchHandlers, WatchOptions } from "../src/sse.js";

/** The catalog the stub serves (the /jobs entry is the subject). */
const STUB_COMMANDS = [
	{
		name: "jobs",
		description: "List jobs (name, next run, last outcome)",
		endpoint: { method: "GET", path: "/v1/jobs" },
	},
] as const;

const JOBS: JobWire[] = [
	{
		id: "api:morning-brief",
		name: "morning-brief",
		source: "api",
		schedule: { cron: "0 7 * * *", timezone: "America/Toronto" },
		action: { kind: "prompt", prompt: "Summarize…", conversation: "new" },
		enabled: true,
		state: "waiting",
		version: 1,
		access: "write",
		nextRun: "2026-10-20T07:00:00.000Z",
		lastRun: {
			jobId: "api:morning-brief",
			version: 1,
			fireAt: "2026-10-19T07:00:00.000Z",
			manual: false,
			outcome: "succeeded",
			startedAt: "2026-10-19T07:00:00.000Z",
		},
	},
	{
		id: "file:nightly-sweep",
		name: "nightly-sweep",
		source: "file",
		schedule: { every: "12h" },
		action: { kind: "task", task: "sweep" },
		enabled: true,
		state: "waiting",
		version: 3,
		access: "read",
	},
];

function stubClient(init?: {
	/** When set, listJobs rejects with this error. */
	listJobsError?: SigrunApiError;
}) {
	const listJobs = vi.fn((): Promise<{ jobs: JobWire[] }> =>
		Promise.resolve({ jobs: [...JOBS] }),
	);
	const getCommands = vi.fn(() => Promise.resolve({ commands: [...STUB_COMMANDS] }));
	const client = {
		listConversations(): Promise<ConversationList> {
			return Promise.resolve({
				conversations: [
					{
						id: 1,
						root: false,
						archived: false,
						pinned: false,
						access: "write",
						lastActivityAt: new Date(2026, 0, 1).toISOString(),
					} satisfies ConversationSummary,
				],
			});
		},
		getConversation(id: number): Promise<ConversationViewWire> {
			return Promise.resolve({
				conversation: { id },
				entries: [],
				docs: {},
				steer: { busy: false, queued: 0 },
			} as unknown as ConversationViewWire);
		},
		getMeta(_id: number) {
			return Promise.resolve({
				pinned: false,
				access: "write",
				tagged: [],
				archived: false,
				draft: { text: "", attachments: [] },
				source: "user",
			});
		},
		listJobs: init?.listJobsError === undefined
			? listJobs
			: vi.fn(() => Promise.reject(init.listJobsError)),
		getCommands,
	};
	return { client: client as unknown as SigrunClient, listJobs, getCommands };
}

const fakeTui = { requestRender: () => {} } as unknown as TUI;

/** Flush the microtask queue (one macrotask drains every chained promise). */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

async function boot(init?: Parameters<typeof stubClient>[0]) {
	const stub = stubClient(init);
	const app = new TuiApp(stub.client, {
		tui: fakeTui,
		watch: () => () => {},
	});
	await app.refresh();
	return { app, ...stub };
}

describe("/jobs (TUI)", () => {
	test("lists every job into the pane notice area: name, next run, last outcome", async () => {
		const { app, listJobs } = await boot();
		app.editor.onSubmit?.("/jobs");
		await flush();
		expect(listJobs).toHaveBeenCalledTimes(1);
		const lines = app.pane.render(100).join("\n");
		// Each job is one notice row: name, next run, last outcome.
		expect(lines).toContain("morning-brief");
		expect(lines).toContain("2026-10-20T07:00:00.000Z");
		expect(lines).toContain("succeeded");
		expect(lines).toContain("nightly-sweep");
		// No next run yet: the row says so instead of a blank cell.
		expect(lines).toContain("no next run");
		// No last run yet either.
		expect(lines).toContain("never run");
	});

	test("a listJobs failure surfaces as a pane error, not silence", async () => {
		const { app } = await boot({
			listJobsError: new SigrunApiError("GET", "/v1/jobs", 500, {
				error: "internal",
			}),
		});
		app.editor.onSubmit?.("/jobs");
		await flush();
		expect(app.pane.render(80).join("\n")).toContain("[error]");
	});

	test("an empty job list prints the empty state", async () => {
		const stub = stubClient();
		// Override to an empty list.
		(stub.client as unknown as { listJobs: () => Promise<{ jobs: JobWire[] }> })
			.listJobs = () => Promise.resolve({ jobs: [] });
		const app = new TuiApp(stub.client, {
			tui: fakeTui,
			watch: () => () => {},
		});
		await app.refresh();
		app.editor.onSubmit?.("/jobs");
		await flush();
		expect(app.pane.render(80).join("\n")).toContain("jobs: none");
	});
});
