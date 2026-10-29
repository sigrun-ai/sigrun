/**
 * Durable v1 fixture maker (pi-durable 1.4.0 upgrade, Task B1 Step 0b).
 *
 * MUST be run while core still depends on pi-durable **1.3.0** — the
 * whole point is a real database written by the OLD schema
 * (`durable_schema.version = 1`), used by the 1.4.0 migration tests
 * (B1's "version-1 waiting checkpoint resumes" and B4's snapshot tests).
 *
 * Run: `npx tsx test/fixtures/make-durable-v1.ts`
 *
 * Contents (all synthetic):
 * - one conversation with an answered turn (faux provider);
 * - one enabled job whose `sigrun.schedule` task is mid-`waiting`
 *   (1.3.0 commits `{status:"waiting", until, checkpoint:{phase:"waiting",
 *   nextAt}}` from `runtime.sleep`), anchored a day in the future so the
 *   task is genuinely asleep when the harness closes;
 * - one `SessionMetaDoc` with a delta history (several patches).
 *
 * The harness closes cleanly (WAL checkpointed on close); the script
 * then asserts `durable_schema.version = 1` and that no `-wal`/`-shm`
 * files remain.
 */

import { existsSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef, TaskId } from "@earendil-works/pi-durable";
import type { JobSpec } from "@sigrun/shared/jobs";
import { loadConfig } from "../../src/config.js";
import { openHarness } from "../../src/harness/boot.js";
import type { ProviderContributor } from "../../src/harness/providers/index.js";
import { writeJobChange } from "../../src/jobs/docs.js";
import type { JobRuntimeDeps } from "../../src/jobs/fire.js";
import { specHash } from "../../src/jobs/spec.js";
import {
	createScheduleTask,
	type ScheduleInput,
} from "../../src/jobs/task.js";
import {
	applySessionMetaPatch,
	SessionMetaDoc,
	type SessionMetaPatch,
} from "../../src/server/session-meta.js";
import { seededIdentity } from "../helpers/identity.js";

const fixtureDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"durable-v1",
);
const dbPath = join(fixtureDir, "sigrun.db");

// A re-run regenerates from scratch (never migrate an existing fixture).
for (const suffix of ["", "-wal", "-shm"]) {
	const file = `${dbPath}${suffix}`;
	if (existsSync(file)) rmSync(file);
}

const workDir = await mkdtemp(join(tmpdir(), "sigrun-fixture-v1-"));
const t0 = Date.parse("2026-10-19T12:00:00.000Z");
const clock = t0;

const faux = fauxProvider({
	provider: "faux",
	models: [{ id: "m", contextWindow: 128_000 }],
});
faux.setResponses([fauxAssistantMessage("fixture answer")]);
const contributor: ProviderContributor = {
	name: "ext-faux",
	providers: [{ provider: faux.provider }],
};
const config = loadConfig({
	SIGRUN_DEFAULT_MODEL: "faux/m",
	SIGRUN_STORAGE_PATH: dbPath,
	SIGRUN_AUTH: "none",
	SIGRUN_WORKSPACE_PATH: workDir,
});
const opened = await openHarness(config, {
	identity: await seededIdentity(workDir),
	extensions: [contributor],
	env: {},
	settingsDir: workDir,
	now: () => new Date(clock),
});

try {
	const defaultModel: ModelRef = opened.defaultModel;
	const deps: JobRuntimeDeps = {
		harness: opened.harness,
		storage: opened.storage,
		registry: opened.registry,
		models: opened.models as Models,
		defaultModel,
		now: () => clock,
		defaultTz: "UTC",
		gatewayLoaded: false,
	};
	opened.registry.install({
		name: "sigrun.jobs",
		tasks: [createScheduleTask(deps)],
	});

	// 1. One conversation with an answered turn.
	const root = await opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: defaultModel },
	});
	const submission = await root.submit(
		{ type: "input", content: "fixture question" },
		BACKGROUND_CONTEXT,
	);
	await submission.wait(BACKGROUND_CONTEXT);
	const conversationId = root.id as number;

	// 2. One SessionMetaDoc with a delta history (three patches).
	const conversation = await opened.harness.conversation(
		conversationId as never,
		BACKGROUND_CONTEXT,
	);
	if (conversation === undefined) throw new Error("conversation gone");
	for (const patch of [
		{ pinned: true },
		{ tagged: ["fixture"] },
		{ draft: { text: "fixture draft" } },
	] satisfies SessionMetaPatch[]) {
		await conversation.commit(async (tx) => {
			const draft = await tx.doc(SessionMetaDoc, conversationId as never);
			applySessionMetaPatch(draft, patch);
		}, BACKGROUND_CONTEXT);
	}

	// 3. One enabled job with its schedule task mid-`waiting`.
	const jobId = "api:fixture-job";
	const spec: JobSpec = {
		name: "fixture-tick",
		schedule: { every: "60s" },
		action: { kind: "prompt", prompt: "say tick", conversation: "new" },
	};
	const hash = specHash(jobId, spec);
	const nowIso = new Date(clock).toISOString();
	await opened.harness.commit(async (tx) => {
		await writeJobChange(
			tx,
			jobId,
			{
				source: "api",
				spec,
				owner: "tester",
				enabled: true,
				createdAt: nowIso,
				hash,
				state: "waiting",
			},
			"tester",
			nowIso,
		);
	}, BACKGROUND_CONTEXT);
	const firstAt = t0 + 86_400_000; // a day out: genuinely asleep at close
	const taskId: TaskId<void> = await opened.harness.commit(
		async (tx) =>
			await tx.createTask(
				createScheduleTask(deps),
				{ jobId, hash, firstAt } satisfies ScheduleInput,
				{
					ownership: { kind: "conversation" },
					conversationId: conversationId as never,
					background: true,
				},
			),
		BACKGROUND_CONTEXT,
	);

	// Wait until the task is parked inside 1.3.0's in-process
	// `runtime.sleep`: the record stays `running` with the checkpoint
	// `{phase:"waiting", nextAt}` (1.3.0's sleep commits NO state — the
	// invocation simply awaits). On a 1.4.0 reopen this record re-enters
	// `waiting`, which commits a durable `sleeping` state.
	const deadline = Date.now() + 10_000;
	for (;;) {
		const record = await opened.harness.getTask(taskId, BACKGROUND_CONTEXT);
		const checkpoint = record?.state.checkpoint as
			| { phase?: string; nextAt?: number }
			| undefined;
		if (
			record?.state.status === "running" &&
			checkpoint?.phase === "waiting" &&
			checkpoint.nextAt === firstAt
		) {
			// Give the invocation one more beat to actually enter the sleep
			// (the checkpoint was committed at task creation).
			await new Promise((resolve) => setTimeout(resolve, 300));
			break;
		}
		if (Date.now() > deadline) {
			throw new Error(
				`schedule task never parked in waiting (state=${JSON.stringify(record?.state)})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
} finally {
	await opened.harness.close(BACKGROUND_CONTEXT);
}

// The fixture MUST be schema v1 and fully checkpointed (no -wal/-shm
// committed alongside). A clean close can still leave a zero-byte WAL,
// so checkpoint explicitly and remove the empty sidecars.
{
	const checkpoint = new DatabaseSync(dbPath);
	checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	checkpoint.close();
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const row = db
	.prepare("SELECT version FROM durable_schema")
	.get() as { version: number } | undefined;
db.close();
if (row?.version !== 1) {
	throw new Error(
		`fixture durable_schema.version = ${row?.version}, expected 1 — is core still on pi-durable 1.3.0?`,
	);
}
for (const suffix of ["-wal", "-shm"]) {
	if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`);
}
console.log(`fixture written: ${dbPath} (durable_schema.version = 1)`);
rmSync(workDir, { recursive: true, force: true });
