import { describe, expect, test, vi } from "vitest";
import type { Context } from "@earendil-works/chord";
import type { Harness, Storage, SubmissionId } from "@earendil-works/pi-durable";
import type { JobRunWire } from "@sigrun/shared/jobs";
import { EventBus, type RunSettledEvent } from "../src/harness/event-bus.js";
import type { SettingsFile } from "../src/harness/settings.js";
import { JobRunDoc } from "../src/jobs/docs.js";
import type { JobRuntimeDeps } from "../src/jobs/fire.js";
import { registerJobObservers } from "../src/jobs/observe.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";

const CTX = {} as Context;
const CONVERSATION = 10 as RunSettledEvent["conversationId"];

function answeredEvent(inputs: readonly SubmissionId[]): RunSettledEvent {
	return {
		conversationId: CONVERSATION,
		inputs,
		inputTexts: inputs.map(() => "job"),
		// The observer reads only the answered discriminator.
		outcome: { status: "answered" } as RunSettledEvent["outcome"],
	};
}

function submission(requestId: string) {
	return {
		status: async () => ({ requestId }),
	};
}

function run(jobId: string, fireAt: string, outcome: JobRunWire["outcome"]): JobRunWire {
	return {
		jobId,
		version: 1,
		fireAt,
		manual: true,
		outcome,
		startedAt: fireAt,
		conversationId: CONVERSATION as unknown as number,
	};
}

const txDoc = async () => ({});

function observerRig(options: {
	readonly records: Readonly<Record<string, JobRunWire>>;
	readonly listedRuns?: readonly JobRunWire[];
	readonly failFirstCommit?: boolean;
}) {
	let runSettled: ((event: RunSettledEvent) => Promise<void>) | undefined;
	const submissions = new Map<SubmissionId, string>();
	for (const [index, fireKey] of Object.keys(options.records).entries()) {
		submissions.set((index + 1) as SubmissionId, `job:${fireKey}`);
	}
	let firstCommit = true;
	const commit = vi.fn(async (callback: (tx: { doc: typeof txDoc }) => Promise<void>) => {

		if (options.failFirstCommit === true && firstCommit) {
			firstCommit = false;
			throw new Error("acme settle failure");
		}
		await callback({ doc: txDoc });
	});
	const harness = {
		submission: async (id: SubmissionId) => {
			const requestId = submissions.get(id);
			return requestId === undefined ? undefined : submission(requestId);
		},
		snapshot: async (doc: unknown, key: unknown) => {
			if (doc === JobRunDoc) return options.records[String(key)];
			if (doc === SessionMetaDoc) return { jobId: "api:acme" };
			// patchJob sees no job record and has nothing further to write.
			return undefined;
		},
		commit,
		observeCommits: () => ({ detach: () => {} }),
	// SAFETY: this rig implements only the observer's narrowed Harness reads/writes.
	} as unknown as Harness;
	const storage = {
		scanDocuments: async () => ({
			items: (options.listedRuns ?? []).map((item, index) => ({ id: index + 1, key: item.jobId })),
			next: undefined,
		}),
		document: async (id: number) => ({
			value: options.listedRuns?.[id - 1],
		}),
	// SAFETY: this rig implements only the storage scans used by listRuns/pruning.
	} as unknown as Storage;
	const eventBus = {
		registerExtension: (_name: string, handlers: { runSettled?: (event: RunSettledEvent) => Promise<void> }) => {
			runSettled = handlers.runSettled;
			return () => {};
		},
		onHostEvent: () => () => {},
	// SAFETY: registerJobObservers needs only these two EventBus registration seams.
	} as unknown as EventBus;
	registerJobObservers({
		harness,
		storage,
		eventBus,
		settings: () => ({}) as SettingsFile,
		// SAFETY: the prompt observer reads only the injected clock.
		runtime: { now: () => 1 } as JobRuntimeDeps,
	});
	if (runSettled === undefined) throw new Error("runSettled was not registered");
	return { runSettled, commit };
}

describe("runSettled exact-key settlement", () => {
	test("a duplicate delivery does not settle another run of the same job", async () => {
		const firstKey = "api:acme:manual:1000";
		const first = run("api:acme", new Date(1000).toISOString(), "succeeded");
		const second = run("api:acme", new Date(2000).toISOString(), "running");
		const rig = observerRig({
			records: { [firstKey]: first },
			listedRuns: [second],
		});

		await rig.runSettled(answeredEvent([1 as SubmissionId]));

		expect(rig.commit).not.toHaveBeenCalled();
		expect(second.outcome).toBe("running");
	});

	test("one settle failure does not strand the remaining runs", async () => {
		const aKey = "api:acme-a:manual:1000";
		const bKey = "api:acme-b:manual:2000";
		const rig = observerRig({
			records: {
				[aKey]: run("api:acme-a", new Date(1000).toISOString(), "running"),
				[bKey]: run("api:acme-b", new Date(2000).toISOString(), "running"),
			},
			failFirstCommit: true,
		});
		const errors: unknown[][] = [];
		const error = console.error;
		console.error = (...args: unknown[]) => { errors.push(args); };
		try {
			await rig.runSettled(answeredEvent([1 as SubmissionId, 2 as SubmissionId]));
		} finally {
			console.error = error;
		}
		expect(error).toBe(console.error);

		// Both runs reach their settle commit; the second prunes afterwards.
		expect(rig.commit).toHaveBeenCalledTimes(3);
		expect(errors).toContainEqual([
			"jobs: runSettled observer failed:",
			expect.objectContaining({ message: "acme settle failure" }),
		]);
	});
});
