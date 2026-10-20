/**
 * The events-stream wire types (core hardening W3 Task 4, spec §7.4): the
 * canonical declarations live in `@sigrun/shared` (`shared/src/views.ts`,
 * `HostEventWire`); this module re-exports them for server-side importers
 * so `src/server/events/*` and `src/server/routes/events.ts` share one
 * import root.
 */

export type { HostEventWire } from "@sigrun/shared/views";
export type { HostEvent } from "../../harness/event-bus.js";
