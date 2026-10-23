/**
 * Boot-fact routes: `GET /v1/meta` (the real health aggregation + seam
 * inventory + collision record) and `GET /v1/commands` (the slash-command
 * catalog). Both are pure derivations over boot-retained state — a client
 * may cache them.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { aggregateHealth } from "../../harness/health.js";
import { isBackupMarkerStale, readBackupMarker } from "../../backup/marker.js";
import { expandableTemplates } from "../../commands/expand.js";
import { discoverTemplates } from "../../commands/templates.js";
import { listSkills } from "../../skills/index.js";
import { expandCommandEntries, type CommandsResponse } from "../commands.js";
import type { ServerContext } from "../context.js";
import {
	HARNESS_VERSION,
	SCHEMA_VERSION,
	SIGRUN_VERSION,
} from "../schema-fixture.js";
import type { MetaResponse } from "../views.js";

/** Register `GET /v1/meta` + `GET /v1/commands`. */
export function registerMetaRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened, config, webuiBundle, commandCatalog } = ctx;
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
			version: SIGRUN_VERSION,
			harnessVersion: HARNESS_VERSION,
			schemaVersion: SCHEMA_VERSION,
			extensions: opened.extensionOutcomes.map((outcome) => {
				const workers = workerStatuses.get(outcome.name);
				const surfaces = opened.extensionSurfaces.find(
					(binding) => binding.extension === outcome.name,
				);
				return {
					name: outcome.name,
					status: outcome.status,
					...(outcome.error === undefined ? {} : { error: outcome.error }),
					...(workers === undefined || workers.length === 0
						? {}
						: { workers }),
					// The declared surfaces (UI-blocks U3 Task 5): the channels'
					// rail/panel registration reads the DECLARATION here (never a
					// second fetch); access-none filtering stays render-time.
					...(surfaces === undefined
						? {}
						: {
								surfaces: surfaces.defs.map((def) => ({
									id: def.id,
									title: def.title,
									icon: def.icon,
									placement: def.placement,
								})),
							}),
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
			// The auth block (W1 Task 6, spec §5.7): the effective method list
			// (resolved once in `createServer`) + the onboarding state — both
			// pure derivations, never per-request negotiation.
			auth: {
				methods: ctx.methods,
				claimed: opened.identity.users.isClaimed(),
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
			// §14.2/§14.4: the development flag — gates the gallery and the
			// development error bodies (a boot constant, cached like the rest).
			dev: config.dev,
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
			// extension-contributed webui bundles, the provider-merge sink,
			// and extension command names (W5 Task 3). Last-registered-wins
			// everywhere; the record is operator visibility, never an error
			// (a core-name command collision is dropped + warned at build,
			// deliberately absent here).
			collisions: {
				webui: opened.webuiBundleCollisions,
				providers: opened.providerCollisions,
				commands: commandCatalog.collisions,
			},
		};
	});

	// The slash-command catalog: the thin metadata list the composer's `/`
	// menu consumes — name, description, args hint, and the endpoint each
	// command drives (pi parity: thin metadata over the endpoints the other
	// routes serve). Since W5 Task 3 this is the MERGED catalog (the core
	// table + extension entries, each carrying its `extension` slug and
	// invoke endpoint). Since Task 2c the response is built PER REQUEST:
	// the trailing `kind: "expand"` entries (every discovered skill as
	// `skill:<name>`, plus the templates) are re-scanned live — skills and
	// templates appear the moment their files land, no reload command. The
	// core + extension halves remain boot constants; see `commands.ts` for
	// the scope rulings.
	app.get("/v1/commands", async (): Promise<CommandsResponse> => {
		// The workspace root (the first of the three) reads through a
		// workspace env, exactly like skill discovery at generation time;
		// the catalog scan uses the root conversation's env — the static
		// workspace every conversation resolves to today.
		const expansion = opened.commandExpansion;
		const env = await opened.envBuilder(
			{ conversationId: ctx.rootId, read: opened.harness },
			BACKGROUND_CONTEXT,
		);
		if (env === undefined) {
			throw new Error("envBuilder returned no ExecutionEnv");
		}
		const skills = await listSkills(env, BACKGROUND_CONTEXT, expansion.skills);
		const templates = expandableTemplates(
			await discoverTemplates(env, BACKGROUND_CONTEXT, expansion.templates),
			expansion.commandNames(),
		);
		return {
			commands: [
				...commandCatalog.commands,
				...expandCommandEntries(skills, templates),
			],
		};
	});
}
