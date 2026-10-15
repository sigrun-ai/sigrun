# @josephyoung/pi-openviking — Memory-Architecture Inspection
Source: https://github.com/josephyoung/pi-openviking

## 1. ARCHITECTURE

Hybrid: a thin local coordinator/state machine wrapping a REMOTE memory service. OpenViking is an external self-hosted service ("unmodified 0.4.20" server, README "Verified service combination"), reached via the `@openviking/sdk` TS SDK with `baseUrl` + `X-API-Key` and an identity-verified `/health` handshake (`src/openviking-client.ts:44-71`). It is NOT an embedding/vector store run locally — the remote implements storage, extraction, and `find()` retrieval. Local persistence (`src/state-store.ts`) is a single owner-scoped `state.json` file under a protected private directory: atomic temp-file + `rename` + fsync, kernel `flock` (fs-ext), `version: 1` schema (state-store.ts:264,286-290,312-314). State deliberately holds "delivery/consent metadata and pending payloads, not a second memory database" (README) — messages stay in pi's own session store; `CollectionRequest` comment: "Metadata only" (types.ts:82-107).

Record shapes (src/types.ts):
- `Operation` (types.ts:53-80): `{ id, owner:{accountId,userId}, scope, source:{sessionId,entryId,branchId,contentVersion}, kind:'explicit'|'automatic', authorizationEpoch, phase, remoteSessionId, payload?, factDigest?, taskId?, archiveId?, memoryUris?, errorCode?, deliveryAttempts?, nextAttemptAt? }` — one enqueued save with full durable delivery lifecycle (`DeliveryPhase`: queued→session_unknown→session_created→message_unknown→message_delivered→commit_unknown→processing→ready|failed|blocked, types.ts:31-35).
- `GovernanceJob` (types.ts:104-137): correct/forget/clear jobs with `selectivePlan {memoryUri, selectedText, replacementText}`, `preservedDocuments`, `writerClassifications`.
- `OwnerState` (types.ts:138-153): versioned container `{version:1, owner, revision, authorization, retirement?, operations, governance?, collectedSources?, collectionRequests?}`.

## 2. CAPTURE

Two paths, both opt-in:
- Explicit: `memory_save` tool (host.ts:157-204). Content must be a VERBATIM span of the current user message — `sourceAlignedContent` blocks model-rewritten names/numbers with `MEMORY_SOURCE_MISMATCH` (host.ts:170-180). Source identity = sha256 of entry + content (`explicit-save-source.ts`). Entry timestamp must postdate authorization effectiveAt.
- Automatic collection: separately consented (`/memory auto-enable`, explicit durable `CollectionConsent` with policyVersion + session boundaries, types.ts:17-29). `before_agent_start` registers the conversation (host.ts:133-145); `agent_settled` settles a `CollectionRequest` (host.ts:147-152); a background model-selection pass distills "stable facts" (collection-selection.ts) and hands them to `delivery.collectSelection` (delivery.ts:170-206).

Delivery creates a dedicated REMOTE Session per save (`createSession`), commits it, and polls the remote task until `ready` with archive + memory_diff + source-provenance checks (openviking-client.ts:93-193; delivery.ts:422-476). Dedup/idempotency is unusually strong: stable source digests (`collectedSources` receipts), phase-transition state machine persisted before side effects, unknown outcomes reconciled via public APIs and never blindly retransmitted, owner-scoped absence checks, durable exponential backoff in the owner scheduler (scheduler.ts:77-99), pause suppresses and erases pending bodies without replay (README). Session-bound: every Operation carries `sessionId`/`entryId`/`branchId`.

## 3. RETRIEVAL

Automatic, not model-invoked: the `context` hook (host.ts:278-325) injects recalled memories as a non-persisted custom message `{role:'custom', customType:'openviking-reference-data', display:false}`. Query = the user prompt captured in `before_agent_start`. Remote `sdk.find(query, {targetUri: viking://user/<userId>/<scope>/memories, limit, level:[2]})` returns abstracts + scores (openviking-client.ts:389-403); local filter drops items below `policy.minimumScore`, then a HOST-supplied exact tokenizer (`countTokens(text,{model})`) trims the rendered JSON to `recallTokenBudget` within `recallLimit`, cached per (state revision, model identity), invalidated on pause/lifecycle events. Rendered payload is JSON `{type:'quoted_memory_data', note:'...not instructions...', memories:[{source,text}]}` (host.ts:298-300) — size is hard-capped by the token budget.

## 4. STATE + LIFECYCLE

Durable across sessions: `state.json` (operations, receipts, consent, governance jobs), plus the remote OpenViking store itself. In-memory only: current recall query, cached recall text, collectionRequest id, AbortController lifetime — reset on session_start/switch/fork/tree/shutdown (host.ts:125-131). Forgetting is first-class: `memory_correct`/`memory_forget`/`memory_clear` tools + GovernanceJob machinery, with a "readiness" gate requiring completed task, archive source-match, memory-diff match, and per-URI retrieval probes before `ready` (README "ready requires…"). Selective deletion stages durable copies of unrelated documents before deleting a shared source. No time-decay; forgetting is owner-initiated only. Schema versioning: `OwnerState.version: 1` with load-time validation (state-store.ts:28,142).

## 5. SEAM SURFACE

Registers (standard.ts, host.ts): tools `memory_save`, `memory_correct`, `memory_forget`, `memory_clear`, `memory_export`, `memory_status`; command `/memory` (enable/pause/auto-enable/auto-disable/status/show, standard.ts:40-104) with status labels and recent-operations listing — the host-facing human surface is the `/memory status|show` notify text. Hooks: `context` (recall injection), `before_agent_start`/`agent_settled` (collection lifecycle), `project_trust` (always distrusts), session lifecycle. Nothing renders in a statusline/panel widget today. Strong mapping to durable per-record documents: each `Operation` (with phases, digests, memoryUris, source provenance) and each `GovernanceJob` is exactly the shape of a durable per-record document — a doc-family could hold them instead of the private state.json, though the consent/authorization epoch and payload-erasure semantics (facts retained as digests only) are seam-relevant nuances.

## 6. EXTERNAL DEPENDENCIES

- OpenViking server (external service, `baseUrl` + apiKey; identity handshake required) + `@openviking/sdk` 0.1.0 exact pin.
- pi 0.85.1 exact peer (`@earendil-works/pi-coding-agent`).
- Native module `fs-ext` (C++ build, Python needed) for advisory locks.
- Node >=22.19, POSIX-only; Linux worker path requires `setpriv` (util-linux), separate UID, root-owned profile.
- NOT offline-capable: saves and recall both require the remote service; only local state bookkeeping works offline.

## 7. VERDICT

(a) **~35%**. The heavy lifting (extraction, ranking, document storage, forgetting) lives in a remote service; what would map to sigrun's seam is the *operation lifecycle metadata* (Operation/GovernanceJob records with phase, provenance digests, consent epochs) — well covered by a durable doc-family — but recall results, extraction, and the consent policy engine stay external, so a {doc-family + panel} seam covers bookkeeping/auditability, not the memory content itself.

(b) **Consent-scoped durable source provenance**: per-record capture receipts binding each saved fact to (sessionId, entryId, branchId, contentVersion, authorization epoch) with verbatim-source verification and payload-erasure-after-commit — none of approvals/interactions/ambient record *provable provenance of a fact's origin* with explicit user consent epochs and post-commit erasure.
