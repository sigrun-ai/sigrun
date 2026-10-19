# Review — `2026-10-19-sigrun-core-hardening-design.md`

Scope: read-only review of the spec against `src/`, `test/`, `webui/src`, `tui/src`, `charts/`, `Dockerfile`, and the pinned `node_modules/@earendil-works/pi-durable/dist/**/*.d.ts`. No files edited. I could not write the incremental artifact (no write tool in this role); the complete artifact is below.

Overall: the spec's *factual* premises are unusually well-grounded — I verified every named upstream claim and found only one materially wrong (`files/raw` bound) plus one mis-shaped (`harness.submission` returns a handle, not a record). The problems are concentrated in W1 (ownership is still mutable, proxy trust is too broad, onboarding/auth ordering is undefined, group sharing cannot be expressed) and W4 (the crash-safety claim does not hold with the stated mechanism).

---

## Blockers

### B1. `PATCH …/meta` still lets a `write` sharee seize ownership — the whole sharing model is bypassable

§5.9 says "Only the owner changes it [sharing], via `PATCH …/meta {sharing}`" and defines `write` as "submit, answer interactions, configure, and fork". But `owner` is *already* a patch field, and the route applies it unconditionally:

- `src/server/session-meta.ts:110` — `readonly owner?: string | null` in `SessionMetaPatch`.
- `src/server/session-meta.ts:237` — `case "owner":` accepts any string or `null`.
- `src/server/index.ts:1638-1690` — `PATCH /v1/conversations/:id/meta` validates and applies the patch with **no ownership check**; `applySessionMetaPatch` writes `draft.owner` (`session-meta.ts:~300`).

So under W1, a sharee with `write` calls `PATCH …/meta {"owner":"me"}`, becomes the owner, then locks the real owner out (the previous owner now has no `accessOf` path at all — §5.6 forbids admin read). `owner: null` is equally fatal: the conversation becomes ownerless → household-**write** (§5.9), i.e. every directory user gains write. This is a privilege escalation *created by* the spec's own access rule, not a pre-existing bug that stays out of scope.

Smallest fix: state in §5.9 that `owner` leaves the patch surface (server-only, stamped at create/fork/import/job-run only), and that `sharing` is patchable **by the owner only** while `name`/`pinned`/`tagged`/`archived`/`draft` are patchable by `write`. Add the test to §10 ("a write sharee's PATCH of `owner` is 400/403 and leaves ownership unchanged").

### B2. Proxy trust keyed on a pod CIDR lets any cluster workload forge an admin

§5.3: `"trustedProxies": ["10.42.0.0/16", "fd00:42::/56"]` with the docs note "dual-stack clusters list both pod CIDRs". Every pod in the cluster is then a trusted proxy. Two consequences:

1. Any compromised workload, sidecar, or job in the pod CIDR can send `Remote-User: <any user>` and act as that user — including an admin — because §5.3 says proxy headers count whenever the *socket peer* is in the list. The "proxy must OVERWRITE these headers" note only governs requests that traverse the proxy; direct pod-to-pod requests bypass it entirely.
2. It compounds §5.8's "browser through the trusted proxy … **No setup code**: the trusted proxy already authenticated the person". On a fresh deploy, the first pod that can reach the Service claims the admin account with zero credentials.

Also note the CIDR choice misses the *real* SNAT source: with `externalTrafficPolicy: Cluster`/NodePort the peer is a **node** IP, not a pod IP, so the documented list is simultaneously too broad and, for some ingress paths, too narrow.

Smallest fix: trust a single proxy identity, not a range — `trustedProxies` as exact IPs (the ingress controller's pod IPs via a headless service or `hostNetwork` node IPs), or require a shared secret header (`X-Forwarded-Auth: <secret>`) that the proxy injects and the server compares. State that a pod-CIDR entry means "every workload in the cluster is an authenticator" so the operator is making that choice knowingly.

### B3. §8.1's crash-safety claim does not hold: `requestId` dedups submissions, not conversations

§8.1: "A fire derives `requestId = job:<id>:<fireAt>`, and the run conversation id is memoed per fire. A crash mid-fire re-enters `firing` and dedups." §10 pins this as "kill -9 mid-`firing` → one run conversation (requestId dedup)".

The dedup that exists is `admitSubmission`'s `submissionByRequest` lookup (`node_modules/.../harness/submissions.js:129-136`), scoped to a **conversation id**. The conversation must exist before the submission can be deduped, and conversation ids are storage-minted (`storage.mintId()`), not derivable. So the sequence is: create conversation → memo its id → submit. A kill -9 **between** the create and the memo leaves an unmemoed conversation; re-entry finds no memo, creates a **second** conversation, and only then dedups the submission (which is now in the second conversation, so it dedups nothing). The stated test cannot pass with the stated mechanism.

Smallest fix: pick one and write it down — (a) memo a *pre-created* marker whose value is deterministic (e.g. `requestId` → conversation id recorded in a session-scoped `JobFireDoc` keyed by `<jobId>:<fireAt>`, committed in the same transaction that creates the conversation), or (b) accept at-least-once conversation creation and weaken the test to "at most one *submitted run* per fire, orphan conversations tolerated and GC'd on next fire". (a) is cheap: `ConversationInit` runs inside the creating commit (`types.d.ts:413-421`), so the doc write and the conversation create land atomically.

### B4. Onboarding is unreachable: the spec never orders `401` before `403 setup_required`

§5.2: "A non-empty list with no match returns `401 {error:"unauthenticated"}`", and `methods` defaults to `["token"]` on a non-loopback bind. §5.8: "While unclaimed: every `/v1/*` route except `/v1/onboarding*` returns `403 {error:"setup_required"}`".

On a fresh chart deploy (binds `0.0.0.0`, `charts/sigrun/values.yaml:89-91`) there are **no tokens and no users**. If authentication runs first, every non-onboarding route 401s and §5.7's "the webui prompts for a token on its first 401" is a dead end — no token exists and none can be minted (`sigrun token create` requires a directory user, §5.4). The flow only works if the unclaimed check precedes authentication, which the spec never says.

Smallest fix: state the middleware order explicitly ("unclaimed-gate → authenticate → authorize"), and state the one exception on the other side: the env service token (`SIGRUN_API_TOKEN`) is evaluated before the unclaimed gate, since §5.8 says it "still works while unclaimed".

### B5. Group sharing cannot be implemented as specified

Three statements cannot all be true:

- §5.9 `Sharing` carries `groups?: string[]` in the `people` variant.
- §5.8's directory entry is `{user, name?, email?, admin, createdAt, source}` — **no groups field**, and the only group source is `principal.groups` from proxy headers (§5.1), which is per-request and not stored.
- §9.7 `host.access.accessOf(user: string | undefined, resource)` takes a **user string**, so it cannot evaluate groups at all; a token-authenticated principal has `groups: []` by construction.

Net: `people.groups` is expressible in the type but never matchable through the only API the spec gives extensions, and invisible to every non-proxy principal (TUI, scripts, cron).

Smallest fix (either): drop `groups` from `Sharing` for this release and note it as a follow-up once the directory carries groups; or change `accessOf` to take the resolved principal and add `groups: string[]` to `users.json` (refreshed from proxy headers on auto-provision).

---

## Should-fix

### S1. Deleting a user permanently orphans their private conversations

§5.8: `DELETE /v1/users/:user` "revokes their tokens and leaves their resources in place, owned by a removed user". Combined with §5.6 ("admin grants no read of another user's private resources") and §5.9 (default `private`), the deleted user's conversations become readable by **nobody**, forever — there is no owner-reassignment route anywhere in the spec. The single most likely trigger is exactly the case the spec is designed for (a household member leaving).

Smallest fix: `DELETE /v1/users/:user?reassign=<user>` (admin) that rewrites `owner` on the departing user's resources, defaulting to the last admin; or a documented boot-time repair command (`sigrun user delete --reassign`). One sentence in §5.8 plus a test.

### S2. `files/raw` is an unbounded read, and its stated bound is false

§7.8: "no 1 MiB cap (bounded by `server.maxUploadBytes` × 4)". Workspace files are written by the agent (bash, tool output, `git clone`), not only by uploads, so nothing bounds them. Today's 1 MiB cap exists precisely for this (`src/server/index.ts:305`, enforced at `:1825`). Removing it turns `GET …/files/raw?path=<a 2 GB file>` into a process-memory blow-up. "Streams the file" is also not what the env API offers: `ExecutionEnv` has `readBinaryFile` (whole buffer) and `openBinaryReader` for **bounded positional** reads (`node_modules/.../env/index.d.ts:173-194`).

Smallest fix: give the route its own knob (`server.maxFileReadBytes`, default 8–16 MiB) and return `413 file_too_large` as today; if true streaming is wanted, say "streams via `openBinaryReader` in chunks" so the builder does not reach for `readBinaryFile`.

### S3. §7.1 "The webui and TUI already ignore the settled body; both keep working unchanged" — true for the body, false for the send guard

The composer's send-serialization is built *around* the blocking contract, and says so: `webui/src/composer/Composer.tsx:589-596` — "the submissions route awaits full settlement server-side, so `sending` stays true for the WHOLE busy turn — gating on `sending` alone made Steer unclickable exactly while a session runs." With a `202` at admission, `sending` clears immediately while `busy` (`view.steer.busy`, `Composer.tsx:369`) only flips on the next frame, so the guard at `Composer.tsx:595` (`if (conversationId === null || (sending && !busy)) return;`) no longer serializes anything. The TUI is genuinely unaffected (`tui/src/ui/app.ts:541` fire-and-forget).

Smallest fix: change §7.1 to "the TUI is unchanged; the webui composer's `sending` guard must be re-derived from `steer.busy` + admission (one client change, listed as a W3 task)" — and delete the now-false comment at `Composer.tsx:589-592` (which W0's comment-cleanup list should include).

### S4. §7.5's inbox boot scan duplicates an index that already exists, and `DocumentQuery` cannot scan across conversations

§7.5: "Served from an in-memory index: built by a storage scan at boot". Two problems:

1. `InteractionsIndexDoc` is already a session singleton holding `pending: Record<conversationId, callIds[]>`, maintained by every seed/answer/expire commit (`src/harness/interactions.ts:135-143`, maintained via `indexPending`/`indexSettled` at `:317` and `:330`). A boot **snapshot of that one doc** gives the inbox for free; a storage scan is strictly worse.
2. `DocumentQuery` requires an exact `scope` (`node_modules/.../types.d.ts:618-621`: `{scope, at, kind?}`), so "scan for kind `sigrun.interaction` across all conversations" is O(conversations) scans — one per conversation — at every boot.

Smallest fix: "built by one `harness.snapshot(InteractionsIndexDoc)` at boot, then maintained from commits" — same code path the per-conversation list route already uses (`src/server/index.ts:1099-1103`).

### S5. Job enumeration and deletion leave permanent tombstones, and `scanTasks` returns them

§8.1: "Enumeration is `storage.scanTasks({kind: "sigrun.schedule"})`. Deletion is `abortTask`. There is no separate job store."

`scanTasks` scans **all** task records matching the filter, terminal ones included, and `TaskQuery.status` takes a single status (`node_modules/.../types.d.ts:592-600`). So: every deleted `api:` job, and every "undeclared → abort" reconciliation, leaves a terminal `sigrun.schedule` record that the naive enumeration re-lists; excluding them needs three scans (pending/running/waiting) or in-memory filtering. There is no purge API (`types.d.ts` has no task delete).

Smallest fix: state "enumeration filters to live statuses (three scans, or one scan + in-memory status filter)" and add a sentence on tombstone growth (accepted, bounded by job churn) — or key the job's identity to a live record in a session-scoped `JobDoc` and treat tasks as an implementation detail.

### S6. Cron conversations will be auto-named, contradicting §8.2

§8.2: "The auto-namer skips it." The namer's only skip is task-owned conversations — `src/harness/boot.ts:711-712` `isTaskOwned: async (id) => (await storage.conversation(id, …))?.owner !== undefined`. A cron conversation is deliberately **ownerless** (§8.2), so it is *not* task-owned and will be named. `naming.ts` also gates on "first settled answered run", which a cron run is.

Smallest fix: name the rule — "the auto-namer skips conversations whose `SessionMeta.source === "cron"` (or that carry `jobId`)" — and add it to the §10 W4 tests.

### S7. `POST /v1/jobs/:id/run` has no access rule, and ownerless jobs "run as" nobody

§8.4 gives `PATCH`/`DELETE` a `write` requirement but says only "`POST /v1/jobs/:id/run` fires now and honors `overlap`. This is also the hook for external triggers (Alertmanager, CI) using a token." §8.3 says "A job runs as its owner" — undefined for the ownerless `file`/`extension` jobs that §8.3 explicitly permits ("Without one they are ownerless").

So: may any authenticated user fire any job? Does a fired ownerless prompt run stamp `owner: undefined` (making the run conversation household-write)? Unanswerable from the text.

Smallest fix: one line — "run-now requires `write` access via `accessOf`; an ownerless job's prompt run stamps no owner and the run conversation is household-write (or is owned by the triggering principal — pick one)."

### S8. §6.5: `registry.uninstall` is not enough to drop the extension's other registrations

§6.5: "An extension declaring a reserved core section key is uninstalled (`registry.uninstall` …). Its outcome flips to `quarantined` … Its event-bus, worker, provider, and seam registrations drop with it."

`registry.uninstall` only republishes the installed list (`node_modules/.../harness/registry.js:65-70`). Providers, seam hosts, health producers, and the event-bus/worker bindings are collected **separately by the loader** into their own arrays at load time (`src/harness/loader.ts:758-764`, populated at `:880-900`), and boot consumes those arrays (`src/harness/boot.ts:450-460`, `:676-699`). Uninstalling the registry entry drops tools/sections/tasks only; the providers, the seam host, and the worker timers survive.

Smallest fix: move the reserved-key assertion **into** `resolvedFromFactory`/the loader's post-resolve validation so a reserved key is a load-time quarantine (nothing is installed or collected), rather than an uninstall in `boot.ts` after everything has been collected. That also makes §6.5's "outcome flips to `quarantined` with the existing message" literally true instead of a special case.

### S9. Per-provider credential writes are silently shadowed by the `"default"` entry

§7.6: `PUT /v1/providers/:id/credential {apiKey}` "writes the provider's `auth.json` entry, then refreshes" and is "restart-free". But the credential bridge resolves the magic `"default"` key **first for every provider id** — `src/harness/providers/auth-bridge.ts:76-86`, same order as `resolveDegenerateApiKey` (`providers/index.ts:353-359`). With a `"default"` entry present (the documented way to configure the env provider), a per-provider write has no effect at all, and the endpoint would report success while nothing changed.

Smallest fix: state the precedence explicitly and either (a) have the route write `"default"` when the target is the resolved default provider, or (b) change the bridge to prefer the provider's own entry over `"default"` for non-default providers.

### S10. `principal.user` must be a directory user, but the env service token's default user has no directory entry

§5.4: "`user` must exist in the user directory. The token carries that user's rights" — then, two bullets later, `SIGRUN_API_TOKEN` "(+ `SIGRUN_API_TOKEN_USER`, default `sigrun`) … needs no directory entry". §5.1 asserts "`principal.user` is a username in the **user directory**".

Consequence: an env-token request that creates a conversation stamps `SessionMeta.owner = "sigrun"`, a user absent from `users.json` — it appears in no share picker, matches no `accessOf` owner arm, and `GET /v1/users` never lists it. §5.6's "the env service token" admin is also unlistable, so `DELETE`/demote guards ("last admin") cannot see it.

Smallest fix: either auto-provision `SIGRUN_API_TOKEN_USER` into the directory at boot (source `"cli"`, `admin: true`), or state that env-token requests stamp no owner unless the user exists.

### S11. The setup code is written into a backed-up directory

§5.8: "written to `<stateDir>/setup-code` (0600), so `kubectl exec … cat` retrieves it." The chart sets `SIGRUN_STATE_DIR=/data/state` on both the pod and the backup CronJob (`charts/sigrun/values.yaml:87-88` and `:195-196`), and `state` is a valid backup section (`docs/extending.md:390-393`). A pre-claim nightly backup therefore archives an admin-granting credential.

Smallest fix: write it under `<dataDir>` (never a backup section) or under `<configDir>` with an explicit "excluded from the `config` backup section" note; or accept it and add "rotate by restarting the pod" to the docs.

### S12. Upgrade path: the `["token"]` default locks out every existing deployment

§5.2's default (`[]` on loopback, `["token"]` otherwise) means the chart's `0.0.0.0` bind (`values.yaml:89-91`) requires a token that no existing deployment has. There is no migration note; every current deploy breaks on upgrade until a token is issued, and issuing one needs the directory, which needs onboarding, which needs the unclaimed gate to work (B4).

Smallest fix: an explicit upgrade paragraph — "existing deployments: set `SIGRUN_API_TOKEN` in the `sigrun-env` Secret before upgrading, then claim and replace it with a user token" — and a chart default that ships that env var commented.

### S13. `PUT …/uploads/:name` must reuse the existing name validation

§6.2 adds a path-param upload. The current route rejects `/`, `\`, `.`, `..` in the body name (`src/server/index.ts:1711-1720`) and namespaces to `uploads/<conversationId>/<name>` (`:1735`). A path param can arrive percent-decoded, so `%2e%2e%2f` reaches the handler as `../`. Nothing in §6.2 says the same validation applies.

Smallest fix: "the path segment is validated by the same rule as the body `name` (`isConfinedPath` + the `.`/`..`/separator rejection)". One clause.

### S14. §7.3 `entries.replace` can never fire; `docs.set` still ships whole docs

Two shape problems in the delta frame:

- `"replace": [/* records whose serialization changed */]` — entries are immutable once committed (`EntryRecord`, `types.d.ts`), and the view's `entries` array is a projection of immutable records. A "changed serialization" for an entry is unreachable; only `docs` mutate in place. Drop `replace` (it is dead surface the shared reducer and the property test must still handle).
- `docs: {set: {kind: {}}}` ships the whole doc. For the streaming case that is `pi.live` — the one doc that changes at ~10 Hz — and it carries every tool slot's `output` window. So R8 is improved by a factor of (entries + 4 docs) but the hot path still re-sends the largest mutable doc per frame. Worth one sentence: "streaming text remains one whole `pi.live` per frame; delta-encoding the slot text is a follow-up."

Smallest fix: delete `replace`; add the follow-up note.

### S15. §7.8 "The workspace stays read-only through the API" contradicts §6.2

§6.2 adds `PUT …/uploads/:name`, which writes into the workspace; §7.8 then asserts read-only. The intent is presumably "no general file editing", but as written a builder must guess.

Smallest fix: "the workspace is read-only through the API except the uploads namespace".

---

## Nits

- **§5.9 vs §9.7 `accessOf` signature.** §5.9's comment says `accessOf(principal, {owner?, sharing?})`; §9.7 exports `accessOf(user: string | undefined, resource)`. Pick one (the §9.7 form cannot see groups — see B5).
- **`/metrics` while unclaimed.** §5.8 says metrics "still serve" during onboarding; §5.6 says `/metrics` requires a principal. State that `/metrics` is 401 (not 403) pre-claim, or add it to the unclaimed exempt list.
- **§6.7's superpowers removal "until §9.4".** §9.4 ships in this same spec (W5), so the README edit would be reverted within the same release. Say "restore the example in W5's README pass" or drop the removal. (`README.md:143`, `:219`.)
- **§9.3's `collisions` dependency.** §2 puts the `/v1/meta` `collisions` field out of scope (owned by the build spec), while §7.6 and §9.3 both consume it. §7.6 names the dependency; §9.3 does not. Add "(provided by the build spec's `/v1/meta` field)".
- **§8.1 `scanTasks` call shape.** `storage.scanTasks({kind})` needs `limit` and `context` (`types.d.ts:722`). Harmless, but the builder will hit it.
- **§5.8 CLI-added users claim the server implicitly.** Claimed is defined as "directory non-empty", so `sigrun user add alice --admin` on a stopped server makes the next boot claimed with no setup code and no claimant-as-first-admin. Say so (it is probably the desired recovery path).
- **§6.9 `sigrun_inflight_submission_oldest_seconds` after restart.** The admission clock lives in the event bus's in-process maps (`src/harness/event-bus.ts`, `#lastAdmission`/`#liveInputs`), populated only from commits the process observes; a run placed before the restart is never re-observed, so the metric reads 0 exactly when a wedged pre-restart run exists. Fine for "wedge while up"; worth one clause.
- **§9.4 host-local skills + remote workspace.** `scanSkills` reads exclusively through the conversation `ExecutionEnv` (`src/skills/index.ts:262-290`); the new `<configDir>/skills/` and package roots are host-local, so a remote env would mix sources. Note it.
- **`entryCount` removal touches fixtures.** Production clients do not read it (only `webui/src/api.test.ts:69,182`, `webui/src/sessions/*.test.tsx`, `tui/test/*`), so the "verified: no client reads it" claim holds — but the field is *required* in `ConversationSummary` (`src/server/views.ts:128`) and every fixture carries it. Say "wire-breaking; update the listed fixtures".
- **§6.9 `sigrun_tasks_live{status}`.** `harness.inspect()` is a Session-line read; at a 15 s scrape it is fine, but note it so nobody adds it to a hot path.

---

## Verified premises

Every claim the task named, plus the ones the spec leans on, checked against code:

| Spec claim | Verdict | Evidence |
|---|---|---|
| `registry.uninstall` exists in pi-durable 1.2.0 (§6.5) | ✅ | `harness/types.d.ts:344`; `harness/registry.js:65-70` (republishes the installed list only — see S8 for what it does *not* drop) |
| `TaskOptions.background` excludes a task from conversation aborts and idle waits (§8.1) | ✅ | `types.d.ts:248`; semantics at `harness/types.d.ts:624-630` and `harness/scheduler.d.ts:88-92` ("With `background`, traversal crosses background boundaries") |
| `runtime.sleep(until)` is a durable wait over the harness clock (§8.1) | ✅ | `types.d.ts:196`; `harness/scheduler.js:1671-1685` (re-reads the clock each timer, so a past deadline returns at once after restart) |
| `storage.scanTasks` enumerates by kind (§8.1) | ✅ (with S5) | `types.d.ts:722`; `storage/sqlite/storage.d.ts:38` |
| `harness.submission(id)` (§7.1) | ⚠️ shape | `harness/types.d.ts:658` returns `Submission` (a handle: `id`/`status()`/`wait()`/`abort()`), not a `SubmissionRecord`; the route needs `submission.status(ctx)` |
| Codemode nested calls go through `api.executeTool` and reach `ToolTask` hooks with `call.parent` (§6.7.3) | ✅ | `codemode/codemode.js:675` `this.api.executeTool(call.name, args, …)`; `harness/tool.js:261` builds the nested call; `tool.js:141` `{...input.call, parent:{taskId, callId}}`; `tool.js:61-65` `beforeTool` receives that `call` (spread preserves `parent`) |
| `SubmissionRecord` carries no timestamps (§6.9, §13) | ✅ | `types.d.ts:329-334` — `{id, conversationId, requestId?}` + type/status/entry/answer/reason/detail only |
| `entryCount` is read by no client (§7.2) | ✅ | `grep entryCount` → production hits only `src/server/index.ts:677` (writer) and `src/server/views.ts:128` (type); all other hits are test fixtures |
| The webui streams via native `EventSource` (§5.4's cookie rationale) | ✅ | `webui/src/stream.ts:77-78` `new EventSource(url)`; the fetch layer sends no auth header at all (`webui/src/api.ts:415-440`) |
| `InteractionRecord` has `answeredBy` (§6.7.2) | ✅ | `src/harness/interactions.ts:~105-112` (`"human" \| "extension"`), validated at `:~200` |
| `ensureHostModuleLinks` leaves a real npm-installed copy alone (§6.4) | ✅ | `src/harness/packages.ts:111-125` ("Present entries are LEFT ALONE … the sync never fights npm's own tree") |
| `HOST_RUNTIME_MODULES` lacks `@earendil-works/chord` (§6.4) | ✅ | `src/harness/packages.ts:79-83` — pi-ai, pi-durable, typebox |
| `extensionsDir` / `SIGRUN_EXTENSIONS_DIR` is parsed but never read (§6.7) | ✅ | set at `src/config.ts:646`; no reader in `src/` (only `config.ts:556` projection into settings and tests) |
| `ExtensionSubmit` / `submitBindings` / `memorySubmit` are dead (§6.7) | ⚠️ contingent | Live path exists (`src/server/index.ts:913-916`, `boot.ts:535-537`, `loader.ts:104-132`); deletable only after the memory extension drops `submit` — which the memory-seam spec already records (`docs/superpowers/specs/2026-10-15-sigrun-memory-seam.md:331`). Cite that dependency. |
| A reserved section key currently fails boot loud (§6.5 "instead of abort") | ✅ | `src/harness/boot.ts:510-524` throws naming extension + key |
| Bootstrap persists the resolved section including defaults (§6.6) | ✅ | `src/harness/settings.ts:718-730` ("the file records what boot actually resolved, env-provided or defaulted"); `src/serve.ts:88-95` |
| `/readyz` currently includes provider + memory health (§6.1) | ✅ | `src/server/index.ts:421-445` (503 when `memory`/`providers`/`storage` ≠ ok) |
| The ServiceMonitor scrapes `/readyz` (§6.9 chart change) | ✅ | `charts/sigrun/values.yaml:288-291` |
| `/files/content` caps at 1 MiB (§7.8) | ✅ | `src/server/index.ts:305`, enforced `:1825-1831` |
| No upload-size knob exists today (§6.2) | ✅ | no `maxUploadBytes`/`bodyLimit` anywhere in `src/` |
| `DEFAULT_WORKSPACE_PATH` is `/home/sigrun` (§6.3) | ✅ | `src/config.ts:196`; chart/compose override it (`values.yaml:63-64`, `docker-compose.yaml:36`) |
| The sidebar re-reads every transcript every 10 s (R7) | ✅ | `webui/src/sessions/useConversationList.ts:32,66-68` → `GET /v1/conversations`, which calls `readView` **per conversation** (`src/server/index.ts:657`) just to take `view.entries.length` (`:677`). TUI: `tui/src/launch.ts:273-275` (10 s), `tui/src/ui/interactions.ts:52` (2 s), `tui/src/ui/ambient.ts:157-162` (timer chain) |
| Submits hold the request open for the whole run (R9) | ✅ | `src/server/index.ts:925-928` `await submission.wait(...)` then `202` with the settled record |
| `approvals-parity.test.ts` + `fixture-approvals` exist (§6.7) | ✅ | `test/approvals-parity.test.ts`; `test/fixtures/fixture-approvals/` |
| README names the approvals extension and the superpowers git source (§6.7) | ✅ | `README.md:16`, `:142-143`, `:218-219` |
| `SIGRUN_STATE_DIR` is set on the main pod **and** the backup CronJob (§6.8) | ✅ | `charts/sigrun/values.yaml:87-88`, `:195-196`; PVC mounted at `/data` for both (`:254-257`) |
| `SessionMeta.source` is `"user" \| "cron"` (§8.2) | ✅ (contradicts §9.5) | `src/server/session-meta.ts:~44`; the patch validator accepts only those two (`:~237`) |
| The interaction index is already a session singleton (§7.5) | ✅ | `src/harness/interactions.ts:135-143`, maintained at `:317`/`:330`, read at `src/server/index.ts:1099-1103` |
| The skills section cap is 4 KB (§9.4) | ✅ | `src/skills/index.ts:57` `SKILLS_SECTION_LIMIT_BYTES = 4096` |
| pi-durable has no conversation deletion (§12 non-goal, §13 ask) | ✅ | no `deleteConversation`/`purge` in `dist/**/*.d.ts` |
| The image runs as root today (§6.10) | ✅ | `Dockerfile` has no `USER`; `charts/sigrun/values.yaml` has no `securityContext`/`runAsNonRoot` |
| The webui's `EventSource` and the TUI's SSE both keep working with a cookie (§5.4) | ✅ | webui: same-origin `EventSource` sends cookies; TUI uses `fetch` with explicit headers (`tui/src/sse.ts:141-190`), so `Authorization` works there |

---

## Over-engineering / cut-or-defer

1. **`Sharing.people.groups`** — cut it this release (B5). It is the one field with no data source.
2. **§7.5's boot scan** — replace with the existing index doc (S4). Deletes a task, not just code.
3. **§7.3 `entries.replace`** — cut (S14). Dead frame surface, plus a property-test obligation.
4. **§7.3 delta frames as a whole** — the cheapest 80 % is "send only changed *docs*, whole, plus entry append/remove", which needs no new `replace` concept and no serialization-comparison fallback. If the property test is the expensive part, land the doc/append filter first and treat per-entry serialization diffing as a follow-up. (Keeping the full-frame reconnect contract is right either way.)
5. **§5.5 `allowedHosts` on non-loopback binds** — the loopback case is the DNS-rebinding hole (R2); the non-loopback case adds a config knob whose only use is a Host-header allowlist behind a proxy that already rewrites Host. Consider deferring it to the OIDC slice.
6. **§6.10's `curl` in the image** — nothing in the spec uses it; drop it from the package list or say what needs it (healthcheck?).
7. **§9.4's three skill roots at once** — `<configDir>/skills/` is cheap; package skills + skills-only packages is the larger piece. If W5 is at risk, `sigrun.skills` in the manifest can land alone and the `git:…/superpowers` README example stays out one more release.

---

## Sequencing with the in-flight build spec

- **File overlap is manageable but not nil.** W0 splits `src/server/index.ts`; the build spec changes the webui-bundle resolution inside it (`resolveWebuiBundle`, `capabilities.channels` reporting the selected bundle name) and `src/config.ts`'s default-bundle anchor. W0 must land **after** that merge (as stated) and must preserve `capabilities.channels`'s new contributed-bundle name — §2 excludes the field but W0's route-module split touches the `/v1/meta` handler that emits it. Add one line to §4: "`/v1/meta` moves to the `meta` module with the build spec's `capabilities.channels`/`collisions` behavior intact."
- **`src/shared/` becomes `@sigrun/shared`.** §7.3 puts the delta reducer in `src/shared/` and both clients import it; the build spec makes `@sigrun/shared` a real package with the tui consuming it. Write the import as the package (or note "the reducer lands in whatever `src/shared` is by then") so the reducer is not written twice.
- **Skills-only packages vs the build spec's entry contract.** The build spec **removes** the `<repo>/index.ts` fallback and requires a built `dist/index.js`; §9.4 requires that a package with *no loadable entry* but declared skills loads with outcome `ok`. Those are two different answers to "no entry found" — the loader must distinguish "declares skills, no entry" (ok) from "declares an entry that does not resolve" (quarantine). Say so explicitly in §9.4.
- **`sigrun/extension` subpath (§9.1).** `package.json` has no `exports` map today; adding one while the package is `private` and run from `src` via tsx is fine, but note that the tui's relative `../../src/server/*.js` type imports (which the build spec is already replacing) are unaffected — a builder may otherwise assume `exports` breaks them.

---

## Merge verdict

**BLOCK.** Five items must be resolved before a builder can plan from this: B1 (ownership is still patchable — the sharing model is bypassable), B2 (pod-CIDR proxy trust is an admin-forgery path), B3 (§8.1's crash-safety mechanism cannot produce the conversation dedup its own test asserts), B4 (onboarding/auth ordering is undefined and decides whether first run works at all), B5 (group sharing is unimplementable against the directory and `host.access` as specified). S1–S15 should be folded before the per-workstream plans are written; the nits can ride.

**Correct in this spec** — worth keeping as written: readiness = storage only (§6.1); the ordered authenticator list with proxy-then-token (§5.3) and the loopback/`["token"]` default rule (§5.2, modulo S12's upgrade note); admin as configuration authority only (§5.6) with hidden-is-404; async submit + `waitMs` (§7.1); `accessOf` as the single sharing primitive (§5.9); jobs as one background pi-durable task per job with `runtime.sleep` and a status doc (§8.1); the exact pi-durable version guard (§6.4); reserved-key quarantine instead of boot abort (§6.5, with S8's mechanism fixed); web-standard `Request`/`Response` for extension routes (§9.2, with the body-parser note added); and "no CORS plugin, no password store, no encryption at rest" as explicit non-goals.