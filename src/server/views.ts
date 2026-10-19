/**
 * §5 wire serializers (Tasks 9a–9d) — the server half of the channel
 * contract.
 *
 * SPLIT (build-and-webui Task 1): the wire TYPES live in the
 * `@sigrun/shared` package (`shared/src/views.ts` — the canonical
 * declarations both clients import; zero-dependency leaf, the intended
 * basis for a generated OpenAPI schema later). This module owns the
 * RUNTIME the server needs: the single serializer every §5 endpoint
 * that returns a conversation goes through, plus a re-export surface so
 * server-side importers keep resolving every wire type from here.
 *
 * Purity (test/views-purity.test.ts): this module may import TYPES from
 * upstream (pi-durable/pi-ai, `import type` only) and re-export the
 * shared package's wire types, but no server/framework runtime modules,
 * no route logic, no `node:` imports — the webui/tui never import this
 * file at runtime, and the rule keeps it that way.
 *
 * Spec §5: the server serves pi-durable's NATIVE views, not a bespoke
 * endpoint list — so the conversation wire payload IS the
 * `ConversationView` (`{ conversation, entries, docs }`; JSON-safe by
 * construction: JsonObject docs, EntryRecords whose `model` messages
 * are plain pi-ai JSON) PLUS the sigrun-side `steer` field (T9d,
 * below). The captured-schema fixture (`schema-fixture.ts`,
 * `view-schema.json`) pins the UPSTREAM shape only — `steer` is a
 * sigrun projection, not upstream drift — and `test/schema-drift.test.ts`
 * trips on upstream drift while asserting the wire is exactly view +
 * `steer`.
 *
 * `serializeConversationView` is the single chokepoint — including each
 * SSE watch frame (T9d) — so the fixture continues to describe the
 * wire.
 */

import type { ConversationView } from "@earendil-works/pi-durable";
import type {
	ConversationViewWire,
	SteerField,
} from "@sigrun/shared/views";

/**
 * Derive the steer field from the view's own docs — no extra inspect()/
 * storage call per frame (the watch fires per revision; the docs are
 * already in the frame).
 *
 * - `busy`: `docs["pi.live"].run` present — LiveState's run control
 *   (taskId + inputs) exists "present exactly while busy"
 *   (pi-durable live.d.ts).
 * - `queued`: `docs["pi.inbox"].items` length — the built-in queue of
 *   submissions waiting for a boundary; absent doc = 0.
 */
function deriveSteer(view: ConversationView): SteerField {
	// docs is an untyped Record<string, JsonObject>; both shapes are
	// narrowed structurally (unexpected shapes fail soft to idle — upstream
	// drift would surface in the schema fixture first).
	const live = view.docs["pi.live"];
	const busy =
		typeof live === "object" &&
		live !== null &&
		typeof (live as { run?: unknown }).run === "object" &&
		(live as { run?: unknown }).run !== null;
	const inbox = view.docs["pi.inbox"];
	const items =
		typeof inbox === "object" && inbox !== null
			? (inbox as { items?: unknown }).items
			: undefined;
	const queued = Array.isArray(items) ? items.length : 0;
	return { busy, queued };
}

/**
 * Serialize one conversation view onto the wire: the upstream view plus
 * the derived `steer` field. A shallow spread (upstream frames are
 * immutable and JSON-safe; `conversation`/`entries`/`docs` are shared
 * by reference — the projection adds one key, it never rewrites
 * upstream state).
 */
export function serializeConversationView(
	view: ConversationView,
): ConversationViewWire {
	return { ...view, steer: deriveSteer(view) };
}

// ─── The wire contract (re-exported from @sigrun/shared) ─────────────────
// Every wire type the §5 surface serves resolves from here (the shared
// package's canonical declarations — type-only re-exports erase at
// compile; JSONL_CONTENT_TYPE is the one runtime re-export).
export type * from "@sigrun/shared/views";
export { JSONL_CONTENT_TYPE } from "@sigrun/shared/views";
