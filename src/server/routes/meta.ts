/**
 * Boot-fact routes: `GET /v1/meta` (the real health aggregation + seam
 * inventory + collision record) and `GET /v1/commands` (the slash-command
 * catalog). Both are pure derivations over boot-retained state — a client
 * may cache them.
 */

import type { FastifyInstance } from "fastify";
import { aggregateHealth } from "../../harness/health.js";
import { isBackupMarkerStale, readBackupMarker } from "../../backup/marker.js";
import { SLASH_COMMANDS, type CommandsResponse } from "../commands.js";
import type { ServerContext } from "../context.js";
import { HARNESS_VERSION, SCHEMA_VERSION } from "../schema-fixture.js";
import type { MetaResponse } from "../views.js";

/** Register `GET /v1/meta` + `GET /v1/commands`. */
export function registerMetaRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened, config, webuiBundle } = ctx;
	app.get("/v1/meta", async (): Promise<MetaResponse> => {
		// Idle-worker projection: re-derived per request (statuses change
		// over the process lifetime); quarantined extensions never
		// registered, so a name miss just yields no workers.
		const workerStatuses = opened.workerStatuses();
		// §6.8 backup honesty: the last-success marker is read PER REQUEST
		// from config.stateDir (the CronJob is a separate process — the only
		// fresh-enough view is the filesystem). Unconfigured stays
		// presence-derived; configured degrades when the marker is absent,
		// corrupt, or older than server.backup.staleAfterHours (default 36 h).
		const backupConfigured = config.backup !== undefined;
		const marker = backupConfigured
			? await readBackupMarker(config.stateDir)
			: undefined;
		const backupHealth: MetaResponse["health"]["backup"] = !backupConfigured
			? "unconfigured"
			: marker === undefined ||
					isBackupMarkerStale(marker, config.backupStaleAfterHours)
				? "degraded"
				: "configured";
		return {
			harnessVersion: HARNESS_VERSION,
			schemaVersion: SCHEMA_VERSION,
			extensions: opened.extensionOutcomes.map((outcome) => {
				const workers = workerStatuses.get(outcome.name);
				return {
					name: outcome.name,
					status: outcome.status,
					...(outcome.error === undefined ? {} : { error: outcome.error }),
					...(workers === undefined || workers.length === 0
						? {}
						: { workers }),
				};
			}),
			// §5 health: pure aggregation over boot-retained §3 producers —
			// memory from the memory extension's producer ("ok" for the no-op
			// default — quarantines surface via extensions[].status, never
			// double-reported here), providers aggregated across
			// contributors (empty → "ok"), and backup from the §6.8 marker
			// derivation above ("configured" only while a fresh success
			// exists — the one storage read this route makes).
			health: {
				backup: backupHealth,
				memory: opened.memoryHealth?.() ?? "ok",
				providers: aggregateHealth(opened.providerHealth),
			},
			// §6.8: the marker's timestamp — when the last successful backup
			// ran, whenever one is recorded against a configured target (a
			// STALE marker still surfaces: "when was the last success" is
			// exactly what a degraded badge begs for).
			backup:
				marker === undefined
					? {}
					: { lastSuccessAt: marker.at },
			// §5 capabilities: backup affordances exist iff a target is
			// configured (the badge, not an error, when absent).
			capabilities: {
				backup: config.backup !== undefined,
			// §4.1/§6 channels: the SELECTED bundle's name ("webui" for the
			// built-in default and explicit paths; a contributed selection's own
			// name) exactly while the channel bundle is mounted; an API-only
			// deploy (gate off or absent default) reports [].
			channels:
				webuiBundle === undefined ? [] : [webuiBundle.channel],
			},
			// The seam inventory: declaration-derived, no doc reads.
			seam: {
				interactions: [...opened.seamKinds]
					.filter(([, kinds]) => (kinds.interaction?.length ?? 0) > 0)
					.map(([name, kinds]) => ({
					extension: name,
					kinds: [...(kinds.interaction ?? [])],
				})),
				ambient: [...opened.seamKinds]
					.filter(([, kinds]) => (kinds.ambient?.length ?? 0) > 0)
					.map(([name, kinds]) => ({
					extension: name,
					keys: [...(kinds.ambient ?? [])],
				})),
			},
			// Boot-merge collisions: name collisions among
			// extension-contributed webui bundles, plus the provider-merge
			// sink (the same field carries both). Last-registered-wins
			// everywhere; the record is operator visibility, never an error.
			collisions: {
				webui: opened.webuiBundleCollisions,
				providers: opened.providerCollisions,
			},
		};
	});

	// The slash-command catalog: the thin metadata list the composer's `/`
	// menu consumes — name, description, args hint, and the endpoint each
	// command drives (pi parity: thin metadata over the endpoints the other
	// routes serve). A boot constant (like /v1/models), so a client may
	// cache it. See `commands.ts` for the scope rulings.
	app.get("/v1/commands", async (): Promise<CommandsResponse> => {
		return { commands: [...SLASH_COMMANDS.values()] };
	});
}
