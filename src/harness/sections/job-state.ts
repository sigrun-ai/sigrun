/** The persistent state folder shared by every run of one job. */

import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import { jobStateDir } from "../../jobs/state-dir.js";
import { SessionMetaDoc } from "../../server/session-meta.js";

/** The services the section reads at render time. */
export interface JobStateExtensionDeps {
	jobsRoot(owner: string | undefined): string | undefined;
	job(id: string): Promise<{ name: string; owner?: string } | undefined>;
}

/** Name a new-conversation job run's persistent, per-owner state folder. */
export function createJobStateExtension(deps: JobStateExtensionDeps): Extension {
	return defineExtension({
		name: "sigrun.job-state",
		sections: [
			section("job-state", async (input, context) => {
				const meta = await input.read.snapshot(
					SessionMetaDoc,
					input.conversationId,
					context,
				);
				if (meta?.jobId === undefined) return undefined;
				const job = await deps.job(meta.jobId);
				if (job === undefined) return undefined;
				const root = deps.jobsRoot(meta.owner);
				if (root === undefined) return undefined;
				return `Job state: this conversation is a run of job "${job.name}" (${meta.jobId}). Its state folder is ${jobStateDir(root, meta.jobId)} — create it if missing. Use it to keep notes between runs (for example, when an issue was first seen). Other runs of this job use the same folder; write files atomically.`;
			}),
		],
	});
}
