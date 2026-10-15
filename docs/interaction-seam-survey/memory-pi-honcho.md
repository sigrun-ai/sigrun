# pi-honcho — Memory-Architecture Inspection
Source: https://github.com/giuseppecrj/pi-honcho
Repo inspected: /tmp/pi-mem-inspect/pi-honcho (shallow clone, not run)

## 1. ARCHITECTURE

Hybrid: **remote summarizer service client** (Honcho cloud SDK, `@honcho-ai/sdk`) + **exact local transcript index** (SQLite FTS5). Two modules compose in `src/index.ts` — `remote/` (lifecycle, delivery, recall, tools, commands) and `local/` (session_search, skills, standing instructions).

- Backing store (remote): Honcho cloud — peers, sessions, conclusions, derived context. Nothing local except tokens (`~/.honcho/config.json`) and the repo registry mapping (`honcho-memory.json` under `PI_CODING_AGENT_DIR`).
- Backing store (local): SQLite FTS5 at `~/.pi/agent/pi-honcho/session-search.sqlite` (`src/local/index.ts:116`), content table + `message_fts USING fts5(content, content='messages')` (`src/local/index.ts:264`) — index is rebuildable, Pi session JSONL is the source of truth.
- A "record": the unit of remote write is a `FinalizedExchange` (`src/remote/exchange.ts:1-5`): `{ operationId, userText, assistantText }`; delivered as chunked peer messages carrying metadata `{ operationId, participant, chunkIndex, chunkCount }` (`src/remote/client.ts:deliverExchange`). Recalled context is `CachedMemory` (`src/remote/memory-context.ts:1-5`): `{ summary?, userRepresentation? }`.

## 2. CAPTURE

- Trigger: NOT every turn's raw events. On `before_agent_start` it snapshots the submitted prompt + entry ids (`src/remote/index.ts:pi.on("before_agent_start")`); on `agent_settled` it takes the latest completed (`stopReason === "stop"`) text-only assistant entry not present pre-run (`latestCompletedAssistant`, `src/remote/index.ts`) and enqueues the pair. Tool calls, shell, images, thinking, aborted turns are never uploaded.
- Privacy gate: `safeExchange` rejects the whole exchange on empty text or secret-pattern hits (`src/remote/exchange.ts:SECRET_PATTERNS`); pending deliveries discarded on privacy disable (`disableProjectMemoryNow`).
- Dedup/idempotency: stable `operationId` = `pi-${assistant.entryId}`; pending/acknowledged state is a durable Pi custom-entry ledger (`DELIVERY_LEDGER_KEY = "pi-honcho-memory.delivery"`, `src/remote/delivery-ledger.ts:5-10`) — crash replay re-enqueues unacknowledged pending exchanges at startup; attempted-but-unacked exchanges are reconciled by scanning remote message history for the operationId (`reconcileOperationIds`, `src/remote/delivery.ts:deliverPending`). Delivery is strictly serialized FIFO (`ExchangeDeliveryQueue`), max chunk 8000 chars, non-blocking with 2s flush deadline at compaction/switch/fork/shutdown.
- Session binding: capture is per-Pi-conversation only at enqueue; the remote target is a **deterministic repository session id** `repo-v2-<sha256(repo origin|cwd + peerName)[:24]>` (`src/remote/session-key.ts:24-25`), persisted via a `SESSION_MAPPING_KEY` custom entry, plus in-memory fork handoffs for clone continuity. Subagents (`PI_SUBAGENT_ID`) are excluded entirely at factory entry (`src/remote/index.ts`).

## 3. RETRIEVAL

- **Automatic injection, once per session**: at startup `session.context({summary:true, tokens:800, peerPerspective: pi, peerTarget: user, limitToSession:false})` → `CachedMemory` (`src/remote/client.ts:fetchCachedMemory`). Injected on every model call via the `context` event as a hidden `custom: "honcho-memory"` message wrapped `<honcho-memory>…untrusted reference…</honcho-memory>` (`src/remote/memory-context.ts:renderMemory`).
- **Adaptive budget**: `contextBudget` — 800 tokens normally, 200 at >75% context, 0 (no injection) at >85% (`src/remote/memory-context.ts`); binary-search prefix truncation.
- **Model-invoked tools**: `honcho_search(query)` → `session.search(query, {limit:10})` capped 8k chars; `honcho_chat(query)` → `pi.chat(query, {target: user, session})` (Honcho-side reasoning); `honcho_remember(content)` → `pi.conclusionsOf(user).create({content, sessionId})` (explicit user-requested persistence). Ranking/embedding is entirely Honcho-server-side (derivation); local `session_search` is FTS5 keyword.
- Forks: `session.clone(messageId)` gives the child session history up to the fork point (`src/remote/client.ts:cloneSession`).

## 4. STATE + LIFECYCLE

- Durable: Pi session custom entries (delivery ledger, session mapping, fork ledger, workspace-reset markers) — replayable and version-tagged by protocol key; `honcho-memory.json` registry (workspace per repo, stable `userPeer`/`aiPeer` identity); `~/.honcho/config.json` OAuth/API-key; local FTS index (rebuildable).
- In-memory only: `cachedMemory`, delivery queue, client state — re-fetched/replayed on session_start.
- Fork: flush + remote `session.clone` recorded in `FORK_LEDGER_KEY`; child isolated if clone fails. Workspace reset: scan all global session files for reset markers → blocks delivery and awaits remote recreation.
- No decay/compaction locally — summarization/derivation lives in Honcho. No storage schema versioning beyond stable custom-entry keys; legacy sessions are never auto-searched/merged/deleted.

## 5. SEAM SURFACE

Registered with Pi (`src/remote/index.ts`, `src/local/index.ts`):
- **Hooks**: `session_start`, `before_agent_start`, `agent_settled`, `context`, `session_before_compact/switch/fork`, `session_shutdown`, `resources_discover` (skills).
- **Tools**: `honcho_search`, `honcho_chat`, `honcho_remember` (shown/hidden by connection state via `setActiveTools`); local `session_search`, `skill_manage`.
- **Commands**: `/honcho [help|status|init|login|setup|enable|disable|session delete]` + direct aliases; `/memory-pin` (standing instructions).
- **UI**: statusline via `ctx.ui.setStatus("pi-honcho", "Honcho: connected · <workspace>")`; notify toasts.
- Doc-family mapping: nothing writes a durable per-record human-readable document. The natural fit is its **delivery ledger pending/acknowledged entries** (durable interaction-style records of "what we tried to remember and whether it shipped") and the repo→workspace registry; recalled `CachedMemory` is ephemeral context, not a record. Secrets-rejected exchanges are a candidate durable privacy-interaction record — currently they only notify.

## 6. EXTERNAL DEPENDENCIES

- Honcho cloud API via `@honcho-ai/sdk` — auth: `HONCHO_API_KEY` or OAuth device flow (`/honcho login`, browser). Workspace-scoped key required. Optional `HONCHO_BASE_URL` self-host escape hatch.
- Node/Bun built-in `node:sqlite`/`bun:sqlite` (no native binary dep), git CLI for `origin` resolution, no embedding model locally, no other API keys. Fully degrades offline: Pi continues, tools hidden, local `session_search`/`skill_manage`/`/memory-pin` work, delivery resumes on reconnect.

## 7. VERDICT

- (a) Durable doc-family + generic panel coverage: **~55%**. The ledger pending/ack pairs, repo→workspace mapping, and identity/registry state map naturally to doc-family records + panel; but the actual memory payload (summaries, representations, conclusions, exchange bodies) is third-party-server-resident state that a local doc family would either duplicate or not own — the panel can show *status and delivery history*, not the memory itself, unless sigrun spec B hosts Honcho itself.
- (b) Most valuable new seam primitive: **a durable delivery/outbox ledger** — per-record pending/acknowledged operation entries with stable operationIds, crash-replay, and idempotent remote reconciliation. Approvals/interactions record human decisions; none of them model "side-effect writes to an external sink that must survive crashes and retry exactly-once." A panel for this (pending/failed/synced counts, last ack time) is the second half of the same primitive.

### Honcho API surface exercised (control note for sigrun spec B)

All via `@honcho-ai/sdk`, workspace-scoped client (`workspaceId` fixed at SDK construction, `src/remote/client.ts:SdkHonchoMemoryClient`):
- **Workspace**: `workspaces()` (list), `deleteWorkspace(id)`; workspace id is chosen per-repo at `/honcho init` (`[A-Za-z0-9_-]+`).
- **Session**: `session(id)` → `addPeers([{peer, {observeMe, observeOthers}}])`, `addMessages(content+metadata[])`, `context({summary, tokens, peerPerspective, peerTarget, limitToSession})` → `{summary.content, peerRepresentation, peerCard}`, `search(query,{limit})`, `messages()` (async history scan), `clone(messageId)`, `delete()`.
- **Peer**: `peer(id, {configuration:{observeMe}})` → `message(content, metadata)`, `chat(query, {target, session})`, `conclusionsOf(target)` → `{list(), create({content, sessionId}), delete(id)}`.
- Two peers per workspace: stable user peer (`observeMe:true`) + pi peer (`observeMe:false`); the pi peer observes the user peer's messages (`observeOthers:true`) — that asymmetry is what produces the user representation. Derivations: `session.context` returns the summary + `peerPerspective`'s representation of `peerTarget`; `chat` is a peer-to-peer reasoning call; conclusions are explicit durable assertions. Recovery reads `messages()` filtering on `metadata.operationId`. Session ids are deterministic (`repo-v2-` hash of origin+peer), one memory session per repo per stable user peer.
