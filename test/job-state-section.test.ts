/** The job-state prompt section and its reserved-key quarantine. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { DocumentReader, PromptInput } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import { createJobStateExtension } from "../src/harness/sections/job-state.js";
import { SessionMetaDoc, type SessionMeta } from "../src/server/session-meta.js";

const SECTION_COLLISION_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-job-state-section-collision", "index.js"),
).href;

const EXPECTED_TEXT =
	'Job state: this conversation is a run of job "nightly-check" (api:1). Its state folder is /r/alice/jobs/api%3A1 — create it if missing. Use it to keep notes between runs (for example, when an issue was first seen). Other runs of this job use the same folder; write files atomically.';

function promptInput(meta: Pick<SessionMeta, "jobId" | "owner"> | undefined): PromptInput {
	const read = {
		snapshot: async (doc: unknown, id: unknown) => {
			expect(doc).toBe(SessionMetaDoc);
			expect(id).toBe(ROOT_CONVERSATION_ID);
			return meta;
		},
	} as unknown as DocumentReader;
	return {
		conversationId: ROOT_CONVERSATION_ID,
		agent: null as never,
		env: undefined,
		shown: {},
		read,
	};
}

function jobStateSection(deps: {
	jobsRoot(owner: string | undefined): string | undefined;
	job(id: string): Promise<{ name: string; owner?: string } | undefined>;
}) {
	const extension = createJobStateExtension(deps);
	expect(extension.name).toBe("sigrun.job-state");
	expect(extension.sections?.map((section) => section.key)).toEqual(["job-state"]);
	return extension.sections![0]!;
}

test("names the run's shared job-state folder using the stamped owner", async () => {
	const roots: Array<string | undefined> = [];
	const ids: string[] = [];
	const section = jobStateSection({
		jobsRoot(owner) {
			roots.push(owner);
			return "/r/alice/jobs";
		},
		async job(id) {
			ids.push(id);
			return { name: "nightly-check", owner: "alice" };
		},
	});
	const input = promptInput({ jobId: "api:1", owner: "alice" });

	expect(await section.render(input, BACKGROUND_CONTEXT)).toBe(EXPECTED_TEXT);
	expect(roots).toEqual(["alice"]);
	expect(ids).toEqual(["api:1"]);
});

test("renders nothing for a conversation without a job id", async () => {
	const section = jobStateSection({
		jobsRoot: () => "/r/alice/jobs",
		job: async () => ({ name: "nightly-check", owner: "alice" }),
	});
	expect(
		await section.render(promptInput({ owner: "alice" }), BACKGROUND_CONTEXT),
	).toBeUndefined();
});

test("renders nothing when the job is unknown", async () => {
	const section = jobStateSection({
		jobsRoot: () => "/r/alice/jobs",
		job: async () => undefined,
	});
	expect(
		await section.render(
			promptInput({ jobId: "api:1", owner: "alice" }),
			BACKGROUND_CONTEXT,
		),
	).toBeUndefined();
});

test("renders nothing when the stamped owner has no jobs root", async () => {
	const section = jobStateSection({
		jobsRoot: () => undefined,
		job: async () => ({ name: "nightly-check", owner: "alice" }),
	});
	expect(
		await section.render(
			promptInput({ jobId: "api:1", owner: "alice" }),
			BACKGROUND_CONTEXT,
		),
	).toBeUndefined();
});

test("boot quarantines a loaded extension declaring the job-state key", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-job-state-section-"));
	try {
		const opened = await openHarness(
			loadConfig({
				SIGRUN_MODEL: "openai/gpt-4o",
				SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
				SIGRUN_WORKSPACE_PATH: dir,
			}),
			{ env: {}, builtins: false, extensionSpecifiers: [SECTION_COLLISION_SPECIFIER] },
		);
		try {
			expect(opened.extensionOutcomes).toEqual([
				{
					name: SECTION_COLLISION_SPECIFIER,
					status: "quarantined",
					error: 'extension "fixture-job-state-section-collision" declares reserved core section "job-state"',
				},
			]);
			expect(opened.registry.snapshot().extension("fixture-job-state-section-collision")).toBeUndefined();
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
