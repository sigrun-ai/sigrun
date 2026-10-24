/**
 * Jobs Task 4 (spec §8.4 + §5.9): the `/v1/jobs` HTTP surface over
 * Task 3's JobsService.
 *
 * ACCESS (§5.9, the conversations rule applied to job records): every
 * route resolves `accessOf(principal, {owner, sharing})` against the
 * job RECORD — hidden is 404 `job_not_found` on every `:id` route and
 * absence from the list (no 403 tell); a read-only caller on a write
 * route gets 403. The owner is server-stamped at create
 * (`principal.user`; a body-carried `owner` is stripped) and moves only
 * through the transfer path; `sharing` is the PATCH share surface
 * (mirrored onto the record from the merged spec, exactly like a
 * declared job).
 *
 * The HISTORY routes (`runs`/`revisions`) answer for a RETIRED job too,
 * until retention trims its records — access is evaluated against the
 * newest REVISION's owner/sharing then (the record is gone with the
 * retire). `GET /v1/jobs/:id` itself requires a live record.
 *
 * DECLARED jobs (`file:`/`ext:` ids) are immutable: PATCH and DELETE
 * return 409 `job_declared` (edit the source instead). Run-now honors
 * the caller's write access and the job's own `overlap`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { accessOf, type Access, type Sharing } from "@sigrun/shared/access";
import type { JobSpec, JobWire } from "@sigrun/shared/jobs";
import { accessPrincipalOf } from "../auth/access-principal.js";
import type { ServerContext } from "../context.js";
import { JobDeclaredError, JobNotFoundError } from "../../jobs/index.js";
import { validateJobSpec } from "../../jobs/spec.js";

/** The §5.9 resource form ({owner?, sharing?}) of a job row. */
function resourceOf(row: { owner?: string; sharing?: Sharing }) {
	return {
		...(row.owner === undefined ? {} : { owner: row.owner }),
		...(row.sharing === undefined ? {} : { sharing: row.sharing }),
	};
}

/** One job resolved for the access rule: the row + the caller's access. */
interface ResolvedJob {
	readonly row: Omit<JobWire, "access">;
	readonly access: Access;
}

/**
 * The shared `:id` error mapping: unknown/hidden → 404 `job_not_found`;
 * visible-but-readonly on a write route → 403 (the callers resolve
 * access themselves; this only serves the two 404/403 replies).
 */
async function deny(reply: FastifyReply, error: "job_not_found" | "forbidden") {
	if (error === "forbidden") {
		return await reply.code(403).send({ error: "forbidden" });
	}
	return await reply.code(404).send({ error: "job_not_found" });
}

/** The service's domain errors → the route's codes (409/404). */
async function domainError(reply: FastifyReply, error: unknown) {
	if (error instanceof JobDeclaredError) {
		return await reply.code(409).send({ error: "job_declared" });
	}
	if (error instanceof JobNotFoundError) {
		return await reply.code(404).send({ error: "job_not_found" });
	}
	throw error;
}

/** Register the `/v1/jobs` routes. */
export function registerJobRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened } = ctx;
	const jobs = opened.jobs;
	const accessPrincipal = (request: FastifyRequest) =>
		accessPrincipalOf(request.principal, opened.identity.users);

	/**
	 * Resolve one job for the access rule: the live record's row when it
	 * exists; for a RETIRED job (the history routes' case) the newest
	 * revision's shape. `undefined` only when neither exists (unknown id).
	 */
	const resolve = async (
		request: FastifyRequest,
		id: string,
	): Promise<ResolvedJob | undefined> => {
		const principal = accessPrincipal(request);
		const wire = await jobs.get(id);
		if (wire !== undefined) {
			const { access: _ignored, ...row } = wire;
			return { row, access: accessOf(principal, resourceOf(row)) };
		}
		// Retired: the newest revision answers until retention trims it.
		const [newest] = await jobs.revisions(id);
		if (newest === undefined) return undefined;
		const row: Omit<JobWire, "state" | "access"> = {
			id,
			name: newest.spec.name,
			source: newest.source,
			...(newest.owner === undefined ? {} : { owner: newest.owner }),
			...(newest.sharing === undefined ? {} : { sharing: newest.sharing }),
			schedule: newest.spec.schedule,
			action: newest.spec.action,
			enabled: newest.enabled,
			version: newest.version,
		};
		return {
			// The retired row's status went with the record; the nudge only
			// needs identity + definition (clients refetch the list).
			row: { ...row, state: "disabled" },
			access: accessOf(principal, resourceOf(row)),
		};
	};

	/** The read guard: unknown/hidden → the 404; the row otherwise. */
	const visible = async (
		request: FastifyRequest,
		reply: FastifyReply,
		id: string,
	): Promise<ResolvedJob | { denied: true }> => {
		const resolved = await resolve(request, id);
		if (resolved === undefined || resolved.access === "none") {
			await deny(reply, "job_not_found");
			return { denied: true };
		}
		return resolved;
	};

	// GET /v1/jobs — the caller-visible rows (hidden absent, access stamped).
	app.get("/v1/jobs", async (request) => {
		const principal = accessPrincipal(request);
		const visibleJobs: JobWire[] = [];
		for (const row of await jobs.list()) {
			const access = accessOf(principal, resourceOf(row));
			if (access === "none") continue;
			visibleJobs.push({ ...row, access });
		}
		return { jobs: visibleJobs };
	});

	// GET /v1/jobs/:id — a live record only (history routes cover retired).
	app.get("/v1/jobs/:id", async (request, reply) => {
		const { id } = request.params as { id: string };
		const wire = await jobs.get(id);
		if (wire === undefined) {
			return await deny(reply, "job_not_found");
		}
		const access = accessOf(accessPrincipal(request), resourceOf(wire));
		if (access === "none") {
			return await deny(reply, "job_not_found");
		}
		return { job: { ...wire, access } };
	});

	// POST /v1/jobs — create (owner = the caller). Validation rejections
	// carry the offending field path (the shared §6 error vocabulary).
	app.post("/v1/jobs", async (request, reply) => {
		const validated = validateJobSpec(request.body);
		if (!validated.ok) {
			return await reply
				.code(400)
				.send({ error: "invalid_field", field: validated.field });
		}
		// The owner is server-stamped (§5.9): a body-carried `spec.owner`
		// is inert for api jobs — strip it so the record's spec and the
		// stamped owner can never disagree.
		const spec: JobSpec = { ...validated.spec };
		delete spec.owner;
		const job = await jobs.createApi(spec, request.principal.user);
		return await reply.code(201).send({ job: { ...job, access: "write" } });
	});

	// PATCH /v1/jobs/:id — write access; the MERGED spec validates whole.
	app.patch("/v1/jobs/:id", async (request, reply) => {
		const { id } = request.params as { id: string };
		const resolved = await visible(request, reply, id);
		if ("denied" in resolved) return;
		if (resolved.access !== "write") {
			return await deny(reply, "forbidden");
		}
		const patch = request.body;
		if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
			return await reply
				.code(400)
				.send({ error: "invalid_field", field: "spec" });
		}
		// §5.9's server-stamped posture: `owner` never moves through a
		// patch (the transfer path owns it) — the conversations rule.
		if ("owner" in patch) {
			return await reply
				.code(400)
				.send({ error: "invalid_field", field: "owner" });
		}
		// Validate the merged spec: a partial patch that breaks the whole
		// is a 400, never a half-applied write. The route merges over the
		// WIRE row minus its record-`owner` key (a wire `owner` would
		// launder through as `spec.owner` — the stamped owner is preserved
		// by the service); `overlap`/`catchUp` ride from the stored spec
		// inside the service (validated at their own writes), and a patch
		// renaming the job carries its own validated name.
		const { owner: _recordOwner, ...base } = resolved.row;
		const merged = validateJobSpec({
			...base,
			...patch,
		});
		if (!merged.ok) {
			return await reply
				.code(400)
				.send({ error: "invalid_field", field: merged.field });
		}
		try {
			// Pass the VALIDATED rebuilt spec (only declared, validated keys
			// survive validateJobSpec's rebuild): a body carrying unknown keys
			// (`id`, `state`, …) can never smuggle them into the stored spec.
			// The service's own spread over the prior spec keeps prior fields
			// the patch left absent (`overlap`/`catchUp`).
			const job = await jobs.updateApi(
				id,
				merged.spec,
				request.principal.user ?? "api",
			);
			return { job: { ...job, access: "write" } };
		} catch (error) {
			return await domainError(reply, error);
		}
	});

	// DELETE /v1/jobs/:id — write access; api jobs only.
	app.delete("/v1/jobs/:id", async (request, reply) => {
		const { id } = request.params as { id: string };
		const resolved = await visible(request, reply, id);
		if ("denied" in resolved) return;
		if (resolved.access !== "write") {
			return await deny(reply, "forbidden");
		}
		try {
			await jobs.deleteApi(id, request.principal.user ?? "api");
			return await reply.code(204).send();
		} catch (error) {
			return await domainError(reply, error);
		}
	});

	// POST /v1/jobs/:id/run — write access; fires now (overlap honored).
	// A LIVE record is required (like PATCH/DELETE): a retired job's
	// revision never satisfies run-now — 404, never fireJob's blocked-200
	// (a deleted job must not be re-triggerable through its history tail).
	app.post("/v1/jobs/:id/run", async (request, reply) => {
		const { id } = request.params as { id: string };
		const wire = await jobs.get(id);
		if (wire === undefined) {
			return await deny(reply, "job_not_found");
		}
		const access = accessOf(accessPrincipal(request), resourceOf(wire));
		if (access === "none") {
			return await deny(reply, "job_not_found");
		}
		if (access === "read") {
			return await deny(reply, "forbidden");
		}
		return await jobs.runNow(id);
	});

	// GET /v1/jobs/:id/runs?limit= — newest first; answers for retired
	// jobs (the revision-resolved access) until retention trims them.
	app.get("/v1/jobs/:id/runs", async (request, reply) => {
		const { id } = request.params as { id: string };
		const resolved = await visible(request, reply, id);
		if ("denied" in resolved) return;
		// limit: default 20, a positive integer, capped at jobHistory.runs
		// (read live — a settings PATCH reaches the next call).
		const query = request.query as Record<string, unknown>;
		const cap = opened.settings.read().jobHistory?.runs ?? 50;
		let limit = 20;
		if (query.limit !== undefined) {
			const parsed = Number(query.limit);
			if (!Number.isInteger(parsed) || parsed <= 0) {
				return await reply
					.code(400)
					.send({ error: "invalid_field", field: "limit" });
			}
			limit = Math.min(parsed, cap);
		}
		return { runs: await jobs.runs(id, limit) };
	});

	// GET /v1/jobs/:id/revisions — newest first; same retired-job rule.
	app.get("/v1/jobs/:id/revisions", async (request, reply) => {
		const { id } = request.params as { id: string };
		const resolved = await visible(request, reply, id);
		if ("denied" in resolved) return;
		return { revisions: await jobs.revisions(id) };
	});
}
