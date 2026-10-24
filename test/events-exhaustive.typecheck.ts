/**
 * Type-level exhaustiveness guard for the /v1/events visibility switch
 * (core hardening review Task 4, Review Focus 4).
 *
 * This file has NO runtime behavior and is never imported by any vitest
 * suite — it exists solely to be compiled by `tsc` (tsconfig.json's
 * `include` covers `test/`, so `npm run typecheck` compiles it).
 *
 * The switch below mirrors `visible()` in
 * `src/server/routes/events.ts`: one case group per `HostEventWire`
 * member (shared/src/views.ts). When a new member is added to
 * `HostEventWire` WITHOUT a case here, `event` in the `default` arm is
 * no longer `never`, the `satisfies never` check fails, and the
 * typecheck gate FAILS — the new member must be classified deliberately.
 * The route's own `default` arm carries the same `satisfies never`
 * check, so an unhandled member can never silently fall through to the
 * ownerless-snapshot broadcast the exhaustive switch replaced.
 */

import type { HostEventWire } from "@sigrun/shared/views";

/**
 * The mirror of `visible()`'s per-type dispatch, at the type level.
 * `admin` is the delivery class settings.changed introduced (U4): the
 * same broadcast mechanics as providers.changed but gated on the
 * principal's admin flag.
 */
type EventDelivery = "conversation" | "broadcast" | "job" | "admin" | "never";

/** The mirror of `visible()`'s per-type dispatch, at the type level. */
function classifyDelivery(event: HostEventWire): EventDelivery {
	switch (event.type) {
		// Conversation-scoped: SessionMeta access re-snapshotted per event.
		case "conversation.created":
		case "conversation.changed":
		case "run.admitted":
		case "run.settled":
		case "interaction.pending":
		case "interaction.settled":
		case "ambient.changed":
			return "conversation";
		// Broadcast to every authenticated principal.
		case "providers.changed":
			return "broadcast";
		// U4 Task 1 (§13.2): settings changes reach admins only.
		case "settings.changed":
			return "admin";
		// accessOf on the event's own job row, enriched with `access`.
		case "job.changed":
			return "job";
		// Host machinery: never principal-facing.
		case "taskSettled":
			return "never";
		// U3 Task 4: delivered only to streams in the watcher registry
		// with stored access ≠ none (the events route's own registry read).
		case "surface.changed":
			return "broadcast";
		default: {
			// A HostEventWire member without a case lands here: `event` is
			// no longer `never`, this check fails, typecheck fails.
			const unhandled = event satisfies never;
			return unhandled;
		}
	}
}

// tsc type-checks every declaration in an included file, so the
// classifier needs no runtime consumer; this type-level reference keeps
// it referenced for linters while the file stays runtime-inert.
export type EventDeliveryKind = ReturnType<typeof classifyDelivery>;
