/**
 * Admin routes (UI-blocks U4 Task 2, spec §13.3):
 * `POST /v1/admin/restart` — the graceful in-place restart.
 *
 * The route exists ONLY under the supervised posture: `server.supervised`
 * (env `SIGRUN_SUPERVISED`, config resolution) promises that something
 * restarts the process after an intentional `exit 0` — the Helm chart
 * and docker compose set it (both restart the container); the
 * Dockerfile deliberately does NOT, so a bare `docker run` reports
 * `not_supervised` rather than dying permanently.
 *
 * Semantics: admin-only (403 before any body read, like PATCH
 * /v1/settings); unsupervised → 409 `{error: "not_supervised"}` and
 * NOTHING runs; supervised admin → 202 `{restarting: true}` and the
 * restart callback is scheduled on the NEXT tick (`setImmediate`) so
 * the response always flushes before the drain begins. The callback
 * (ServerContext.requestRestart, the serve composition's
 * graceful-shutdown + `process.exit(0)`) owns the exit — the route
 * never calls exit itself.
 *
 * D5 parked-task recovery (pi-durable 1.4.0, Task B6):
 * `GET /v1/admin/tasks?state=blocked` lists blocked tasks from
 * `harness.inspect()` (id, kind, reason, conversationId, owner from the
 * conversation's SessionMeta when present); `POST /v1/admin/tasks/:id/retry`
 * returns 404 unknown_task / 409 not_parked unless the task is blocked
 * with reason restart_limit, else calls `harness.retryTask(id)` → 204.
 * The inspect-first check is load-bearing: retryTask rejects an unknown
 * id but SILENTLY no-ops for a task that isn't parked. Both endpoints
 * are admin-only (403 forbidden).
 *
 * Durability (Review Focus 4): the restart rides the SAME ordered
 * shutdown as the SIGTERM path — the event bus drains pending settles
 * and the harness close seals storage, so a run in flight at restart
 * has its submission durable before exit; pi-durable resumes it after
 * the supervisor brings the process back.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TaskId, TaskInspection } from "@earendil-works/pi-durable";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";
import { SessionMetaDoc } from "../session-meta.js";

/** The list row for one blocked task (D5): identity + owner where known. */
interface AdminTaskRow {
	readonly id: number;
	readonly kind: string;
	readonly reason: string;
	readonly conversationId: number;
	readonly owner?: string;
	readonly extension?: string;
}

/** Register the `/v1/admin` routes. */
export function registerAdminRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	app.post("/v1/admin/restart", async (request, reply) => {
		// Admin-only: a restart is a control-plane action (it kills every
		// in-flight connection, including other users' streams) — the
		// gate runs before the supervised check so a non-admin learns
		// nothing about the deploy's supervision posture.
		if (!request.principal.admin) {
			return await reply.code(403).send({ error: "forbidden" });
		}
		if (!ctx.config.supervised) {
			return await reply.code(409).send({ error: "not_supervised" });
		}
		// Deferred past the reply: the 202 must reach the client before
		// the drain closes its connection. A supervisor is expected, so a
		// missing callback (a hand-built server in a test that forgot the
		// seam) is a loud boot-composition error, not a silent no-op.
		if (ctx.requestRestart === undefined) {
			throw new Error(
				"admin restart: supervised but no restart callback wired (serve composition error)",
			);
		}
		const restart = ctx.requestRestart;
		setImmediate(() => {
			void Promise.resolve(restart()).catch((error: unknown) => {
				// The shutdown path is already committed at this point —
				// nothing to roll back to; log loud and let the exit/error
				// surface in the deploy's logs.
				console.error("sigrun: restart shutdown failed:", error);
			});
		});
		return await reply.code(202).send({ restarting: true });
	});

	// D5 parked-task recovery. `GET /v1/admin/tasks?state=blocked` lists
	// blocked tasks from `harness.inspect()`; `POST /v1/admin/tasks/:id/retry`
	// re-runs a restart-parked task. Both admin-only (403 before any
	// inspection, so a non-admin learns nothing about the task graph).
	app.get("/v1/admin/tasks", async (request, reply) => {
		if (!request.principal.admin) {
			return await reply.code(403).send({ error: "forbidden" });
		}
		const query = request.query as Record<string, unknown>;
		// Only the blocked projection exists (the recovery surface); any
		// other state filter is a fail-loud 400, same posture as the
		// conversations list's strict booleans.
		if (query.state !== undefined && query.state !== "blocked") {
			return await reply.code(400).send({ error: "invalid_field", field: "state" });
		}
		const inspection = await ctx.opened.harness.inspect(BACKGROUND_CONTEXT);
		const blocked = inspection.tasks.filter(
			(task): task is TaskInspection & { state: { kind: "blocked"; reason: string } } =>
				task.state.kind === "blocked",
		);
		// Owner: the conversation's SessionMeta.owner when it has one.
		// Reads are snapshots (never materialize the doc); a raced read
		// degrades to an omitted owner, not a failed list.
		const owners = new Map<number, string | undefined>();
		for (const task of blocked) {
			const conversationId = Number(task.record.conversationId);
			if (owners.has(conversationId)) continue;
			try {
				const meta = await ctx.opened.harness.snapshot(
					SessionMetaDoc,
					task.record.conversationId,
					BACKGROUND_CONTEXT,
				);
				owners.set(conversationId, meta?.owner);
			} catch (error) {
				console.error("admin tasks: SessionMeta snapshot failed:", error);
				owners.set(conversationId, undefined);
			}
		}
		// Extension: task names are unique across installed extensions, so
		// ONE registry snapshot resolves the owning extension. Built-in
		// generation/tool/compaction tasks have no installed extension and
		// correctly omit the field.
		const extensionsByTask = new Map<string, string>();
		for (const extension of ctx.opened.registry.snapshot().installed()) {
			for (const task of extension.tasks ?? []) {
				extensionsByTask.set(task.definition.name, extension.name);
			}
		}
		const tasks: AdminTaskRow[] = blocked.map((task) => {
			const conversationId = Number(task.record.conversationId);
			const owner = owners.get(conversationId);
			const extension = extensionsByTask.get(task.record.kind);
			return {
				id: Number(task.record.id),
				kind: task.record.kind,
				reason: task.state.reason,
				conversationId,
				...(owner === undefined ? {} : { owner }),
				...(extension === undefined ? {} : { extension }),
			};
		});
		return await reply.send({ tasks });
	});

	app.post("/v1/admin/tasks/:id/retry", async (request, reply) => {
		if (!request.principal.admin) {
			return await reply.code(403).send({ error: "forbidden" });
		}
		const { id } = request.params as Record<string, string>;
		const taskId = Number(id);
		if (!Number.isInteger(taskId) || taskId < 0 || String(taskId) !== id) {
			return await reply.code(404).send({ error: "unknown_task" });
		}
		// Check inspect() FIRST: pi-durable's retryTask rejects an unknown
		// id but SILENTLY no-ops for a task that isn't parked — the 409
		// must come from the inspection, not from retryTask.
		const inspection = await ctx.opened.harness.inspect(BACKGROUND_CONTEXT);
		const task = inspection.tasks.find(
			(candidate) => String(candidate.record.id) === id,
		);
		if (task === undefined) {
			return await reply.code(404).send({ error: "unknown_task" });
		}
		if (task.state.kind !== "blocked" || task.state.reason !== "restart_limit") {
			return await reply.code(409).send({ error: "not_parked" });
		}
		// For a schedule task the job's status fields return to `waiting`
		// on the task's next committed state (the task's own phases patch
		// the record) — the route deliberately does NOT hand-patch the job.
		await ctx.opened.harness.retryTask(task.record.id as TaskId, BACKGROUND_CONTEXT);
		return await reply.code(204).send();
	});
}
