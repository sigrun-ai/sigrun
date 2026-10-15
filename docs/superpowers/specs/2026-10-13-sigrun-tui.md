# Sigrun TUI design

> Status: design, pending approval. The *what*, companion to the *why* already
> in CONTEXT.md ("The interaction surfaces (webui now, TUI and audio later)
> attach to the in-cluster core from anywhere over the tailnet") — pulled
> forward, per the user: the TUI is the gate for showing sigrun publicly.

Written 2026-10-13, revised 2026-10-15 after the memory-seam / interaction /
ambient seam work landed on main. Everything the user decided is stated as
theirs; "my call" marks the defaults I chose (which they may override).

---

## 1. Intent

Sigrun cannot be considered ready to show the world without a terminal surface.
The webui is the primary surface (CONTEXT §3.4) and stays that way; the TUI is
the second client of the same harness, and the first one that suits its primary
audience — the user, then the technical folks they share the repo with.

The TUI is deliberately simple: pi's idiom, not a new invention. And it must
be buildable without growing the server: the harness API already exposes
everything a conversation client needs (list, create, get, SSE stream,
submissions, fork, interactions, ambient, meta). Where it doesn't, this design
either names the seam or routes around it — it does not redesign the server.

**The parity rule (user's ruling, 2026-10-15):** TUI and webui are
feature-parity clients of the same harness. Differences in behavior are
expected where the medium forces them (an attach button is a webui thing; a
keybinding is a TUI thing), but they are minimal and deliberate, never
accidental. If the webui can do it, the TUI can do it — or the doc says why
it can't.

## 2. Goals / non-goals / anti-goals

**Goals**

- A thin TUI client over the harness HTTP + SSE API — the same contract
  the webui consumes (`/v1/conversations*`, the SSE view stream, the
  interaction/ambient seams, `PATCH /v1/conversations/:id/meta`), plus the
  two server seams this design names (§5 auth hook, §10 enumeration).
- Conversation list + switcher (sidebar), conversation creation, and
  fork — fork is a first-class, obvious action, not a buried endpoint.
- The conversation pane in pi's idiom: user prompts, LLM thinking, tool
  calls as compact rows, assistant text streaming live, composer footer.
- The interaction stack (approvals' successor) surfaced and answerable
  from the TUI — the channel-agnostic seam the webui already consumes.
- The ambient surfaces (statusline/panel state extensions write) rendered
  in the TUI — the same seam the webui already consumes.
- Identity carried on every request as a seam, uniform across TUI and
  webui (the auth hook is §5; no auth flow yet).
- A launcher story: `sigrun`, `sigrun serve`, `sigrun attach`.

**Non-goals (deferred, with the seam named)**

- Multi-user auth (OAuth/Authelia, login flows). The seam — an identity
  header threaded through every request — ships; the auth does not.
- Conversation deletion. The server has no delete endpoint anywhere
  (conversation endpoints: list/create/get/stream/submissions/configure/
  fork/compact/abort/meta/export/import, plus interactions/ambient/files/
  uploads). Archive exists in the meta schema (`archived: boolean`,
  settable via `PATCH /v1/conversations/:id/meta`) and the TUI honors it
  (archived conversations hidden from the default list); delete stays
  absent.
- A settings panel in the TUI. `/v1/settings` exists; the webui has the
  panel (pi parity T8b); the TUI consumes defaults.
- Image/attachment input in the composer. The uploads/files endpoints and
  the `draft.attachments` schema stay a seam; the webui has attach
  affordances the TUI deliberately lacks (the parity rule's named
  difference).
- herdr-plugin territory: panes, multi-agent orchestration, kanban.

**Anti-goals (would be failure even if it worked)**

- A second agent loop. The loop lives in the harness; the TUI submits
  and watches. If any TUI code starts managing conversation state the
  server already owns, it's wrong.
- A platform. No plugin system in the TUI, no generalized surface
  framework.
- Reinventing pi's TUI look from scratch.

## 3. The surfaces

### 3.1 The command surface (the binary, not the TUI's to own)

The launcher split is the core binary gaining entrypoint options, not the
TUI gaining a server. Sigrun today is a cluster deploy with one entrypoint
(`npm start` → `src/index.ts`; the comment in that file calls it "the
composition the Deployment's container command runs"). This design adds:

| Command | Behavior |
|---|---|
| `sigrun` | Boot API + webui statics + TUI in one process (workstation mode). Always local — the harness boots in-process; remote harnesses are `attach`'s job. |
| `sigrun serve` | Boot API + webui statics, no TUI (headless). |
| `sigrun attach [--server <url>]` | Boot the TUI only, against a harness it can reach (default `http://localhost:<port>`; `--server` for the tailnet case). |

**Lifecycle rule (user's call):** the agent dies with the TUI in workstation
mode. If the bare-`sigrun` TUI exits, the harness exits with it — nothing
lingers as a surprise background process. `sigrun serve` is the only way to
leave the harness up headless.

**Cluster path unchanged.** The cluster deployment keeps running the
monolithic `src/index.ts` entrypoint (the Deployment's container command).
`serve` is a new workstation/headless mode; the cluster deploy does not
switch to it, and this design does not rewire the deploy. No behavior
forced on the deploy entry.

**Config (user's ruling, correcting my earlier call):** sigrun grows config
files — pi has several (`settings.json`, `auth.json`, `mcp.json`, …) and
sigrun inevitably will too (`auth.json` when a credential-store extension
lands, `mcp.json` when the MCP extension lands, etc.). The TUI is the first
surface that needs one, so the config-file *convention* is designed here
once, not per-file.

The rule, following pi's shape: **one config directory with purpose-scoped
files, not one big config file.** The TUI client gets its own file holding
the §5 `user`/`server` fields, in a shape that can grow an OAuth section
later without breaking. The harness's boot config stays env-var driven
(`src/config.ts` is the contract; the cluster Secret feeds it, and a
workstation shell profile does the same job) — this design does not move it,
but it no longer forbids a future spec from adding a `config.json` if the
env surface grows past what env vars express well. Env vars remain the
bootstrap contract because the deploy path already is one; a file may come
to *supplement* env for workstation ergonomics, never to replace it.

The config directory already exists in code: `SIGRUN_CONFIG_DIR` →
`~/.config/sigrun` (settings.ts:248), with `settings.json` as its first
file. The TUI's config file joins that same directory — the convention is
formalized, not invented, and no parallel root gets created.

**Seam for later:** the subcommand dispatch is a thin switch at the process
boundary. The `serve`/`attach` split is a familiar shape (opencode's pair is
the one CONTEXT §3.1 names), but sigrun's is justified by what sigrun is —
a headless harness plus thin clients — not by precedent. The workstation-mode
`sigrun` is the new one, and it's the one that pairs the two:

### 3.2 The TUI layout

Single screen. Sidebar left, conversation right, composer bottom.

```
┌────────────────┬──────────────────────────────────────────┐
│ CONVERSATIONS  │                                          │
│                │   [assistant] Here's what I found…       │
│ * research     │   [tool] web_search · 4 results          │
│   media-cleanup │   [thinking] let me cross-check…         │
│ + new          │                                          │
│                │                                          │
│                │                                          │
├────────────────┴──────────────────────────────────────────┤
│ > _                                                       │
└───────────────────────────────────────────────────────────┘
```

- **Sidebar.** Conversations listed (active marked, e.g. `*`; named ones by
  name, unnamed by id/first-prompt). `+ new` creates one. Archived
  conversations hidden by default. Forks appear as siblings — they're just
  conversations, the server's fork endpoint does the work. The sidebar is
  the user's stated need ("a sidebar or something where users can switch
  between conversations").
- **Conversation pane.** Pi's idiom: entries rendered top-to-bottom —
  user prompts, assistant text streaming, thinking blocks, tool calls as
  compact one-line rows that can be expanded. The SSE view stream is the
  single source of truth (wire view on connect, per-revision frames after),
  exactly as the webui consumes it.
- **Composer.** Bottom line, pi-style. `/`-prefixed input routes to the
  slash-command catalog the server already exposes (`/v1/commands`); the
  composer menu can lag the webui's (T7b) without blocking the TUI.
- **Fork affordance.** An action on the current conversation ("fork this"),
  which creates the fork server-side, switches to it, and the original stays
  in the sidebar. Both stay live in parallel — they're separate server-side
  conversations.
- **Approvals.** The interaction seam's pending stack — the webui renders
  it as cards; the TUI renders it as a visible prompt in the conversation
  pane drawn from `GET /v1/conversations/:id/interactions` and answered via
  `POST .../interactions/:callId/answer`. Channel-agnostic by construction
  — the extension writes one record; every surface renders it its own way.
  See §6.

**What's not there:** model/settings pickers, panes, a second sidebar for
files, kanban. This is the pi-look client, nothing more.

## 4. How it's built

### 4.1 Stack (my call)

- **`@earendil-works/pi-tui`** for the terminal UI. pi ships it as a package
  (present in pi 1.1.0's `node_modules/@earendil-works/pi-tui`), and sigrun
  already depends on the same org's `pi-ai`, `pi-durable`, and `chord`. This
  gives pi's exact input/render idioms rather than approximating them.
- **TypeScript**, same as the rest of sigrun; no second runtime.
- **Plain `fetch` + `EventSource`-style SSE reading** over the existing
  endpoints (the webui proves the contract; the server comment notes the
  SSE stream is hand-rolled, no `@fastify/sse` — a client-side SSE reader
  is all that's needed).
- **Lives in the sigrun repo** as a `tui/` workspace alongside `webui/` —
  not a separate repo. It's a first-party surface, not an extension, so
  the extension-separation rule doesn't apply; keeping it in-repo means
  the API contract and both clients evolve in one place.

**Distribution (my call):** a repo-local runnable (`npm run tui`, plus the
`sigrun`/`serve`/`attach` entrypoints) for v1. Publishing a binary so people
can `npx sigrun` is a follow-up, not part of this build.

### 4.2 The client shape

One thin layer, three pieces:

- **API client.** Typed wrappers over the wire types already exported from
  `src/server/views.ts` (`ConversationList`, `ConversationViewWire`,
  `SubmissionResponse`, `InteractionWire`, `AmbientWire`, etc.). No
  re-derivation of shapes.
- **SSE watcher.** Connects `/v1/conversations/:id/stream`, renders
  snapshots and revision frames, reconnects per the server's documented
  reconnect contract (a snapshot subsumes any missed frame).
- **Terminal UI.** pi-tui components: a list widget for the sidebar, a
  transcript renderer for the conversation, an input box for the composer,
  a y/n prompt for approvals.

State the TUI holds: the currently-open conversation id and the latest view —
nothing more. Everything else is re-fetched. This is the "no second agent
loop" rule made structural.

## 5. The auth seam (naive → OAuth, one boundary)

**User's decision:** multi-user must be a seam, not a front-door requirement,
and the seam must accommodate the full spectrum — naive (no auth), HTTP
Basic, a custom header, and OAuth/OIDC — without any becoming a rewrite.

The one rule that makes all four possible: **authentication is a transport
concern at the server boundary, never a client concern and never baked into
"the TUI sends a header."** Each scenario is a server-side check that runs
in one place, and the client only supplies credentials as transport detail.

| Scenario | Server boundary does | Client does |
|---|---|---|
| **Naive (no auth)** | nothing; requests pass through unidentified | nothing |
| **HTTP Basic** | Fastify validates user/pass, extracts the user identity | sends credentials like any HTTP client |
| **Custom header** (the tailnet deployment) | Fastify reads `X-Sigrun-User: <name>` | TUI sends it (`--user`/`SIGRUN_USER`); webui gets one configured value |
| **OAuth/OIDC** (Authelia — the household case) | Fastify validates the bearer/redirect, extracts identity from the IdP | webui follows the login redirect; the TUI does the device/token dance a terminal does |

`SessionMeta.owner` exists in the schema and is settable via PATCH; what
this adds is stamping it at creation from the resolved identity. The hook
is one place — a Fastify request-hook that resolves identity and stamps it
as `owner` at conversation-creation. The custom-header check is the first
one implemented because it's the tailnet deployment's need; the other auth
methods slot into the same hook without the TUI or webui changing how they
carry identity.

**Client identity is uniform:** both the TUI and the webui send identity on
every request the same way (`X-Sigrun-User` in v1), so no conversation lands
ownerless just because of which surface created it. The webui's identity is
a single configured value; the TUI's comes from `--user`/`SIGRUN_USER`/config.

**Not built:** per-user filtering on `GET /v1/conversations`. The schema
permits it; enforcing it is part of the auth work, not the TUI. v1 shows
all conversations, as the webui does today. OAuth/OIDC itself — the Authelia
wiring — is its own follow-up spec; this design only guarantees the seam
doesn't have to be torn out to add it.

## 6. The interaction + ambient seams are channel-agnostic

User's ruling, restated as a design constraint: **extensions are
channel-agnostic** — the surface an extension uses must be the same whether
the client is the webui or the TUI. The interaction and ambient seams
(landed on main after this spec was first written) are exactly that rule
realized: an extension writes one record, and every surface renders it its
own way.

What that means concretely:

- The server's interaction endpoints (`GET /v1/conversations/:id/interactions`,
  `POST .../interactions/:callId/answer`) and ambient endpoints
  (`GET /v1/conversations/:id/ambient`) are the universal contract. The
  approval flow that used to live in `/v1/conversations/:id/approvals` now
  lives here as one kind of interaction.
- The TUI implements that contract like any diligent client — list pending,
  render the stack, POST the decision. It gains **no** TUI-specific
  machinery, and the extensions gain no TUI awareness. The webui's
  `InteractionCards`/`AmbientPanels` and the TUI's equivalents are two
  renderers of the same records.
- The parity rule (§1) governs: if the webui renders it, the TUI renders
  it, or the doc says why the medium doesn't admit it.

## 7. Constraints

- **Server surface added by this design, all named:** (a) the auth hook (§5);
  (b) durable conversation enumeration (§1's listing endpoint — see §10);
  (c) the CLI entrypoints (§3.1). Nothing else. Anything the TUI thinks it
  needs beyond these is a spec amendment, not a patch.
- **Config files are a designed convention, not forbidden.** §3.1 owns it:
  a config directory with purpose-scoped files (pi's shape), the TUI's file
  first. The harness boot config stays env-var driven; a future spec may add
  a file that supplements it. The CLI is an argument switch, not a config
  loader — and it is also not a barrier to config.
- **No second agent loop.** §4.2 is the enforcement.
- **Trusted-network deployment.** The auth seam is honest about this:
  the naive and custom-header deployments are not security. The cluster
  path, the tailnet, and local are the supported settings; the public
  internet is the OAuth/OIDC deployment's problem, not this design's.
- **`pi-tui` version drift.** pi 1.1.0 depends on `@earendil-works/pi-tui@
  ^1.1.0`; sigrun adds it as a **new** direct dependency (not already in
  its tree), pinned to the 1.x line compatible with pi 1.1.0, treated as a
  deliberate upgrade like pi-durable. **pi-durable is 1.2.0** — the
  codemode-parity merge (`64a0642`) landed the 1.0.2→1.2.0 upgrade on
  main; this spec targets the current pin. The 1.2.0 tool-result rename
  (`content`→`output`) is already absorbed.
- **Reuse measurement doesn't apply here.** The 60%-reuse gate (core spec)
  is for the webui frontend port from hermes-webui. The TUI is a different
  surface adopting pi's idiom; the gate doesn't reach it.

## 8. What's left to the builder

- pi-tui's actual component API (what a list/transcript/input look like in
  code) — the design names the intent, not the widget signatures.
- Sidebar interaction details (key bindings for switching, whether the
  sidebar toggles) — pi-tui's conventions lead.
- The exact composer keymap and how `/` completion renders, pending a look
  at how much of T7b's menu is reusable headlessly.
- Fork-point selection (fork at the latest entry vs. a chosen entry) — the
  endpoint supports options; the TUI's v1 default is fork-at-latest.
- The subcommand argument parsing library/mechanism for the binary.
- **The config-directory location and the TUI config file's exact name** —
  the convention is pi-shaped (a directory of purpose-scoped files, §3.1),
  rooted at `SIGRUN_CONFIG_DIR` → `~/.config/sigrun`. The builder picks the
  filename. The `user`/`server` fields' shape must be able to grow an OAuth
  section later without breaking.
- **The enumeration plumbing (§10).** The server's storage handle lives in
  `openHarness` (boot.ts:268) and `createServer` receives only
  `OpenedHarness` — so how `scanConversations` reaches the route is a
  design-shaped builder decision: `OpenedHarness` gains a storage accessor,
  or the enumeration rides a new `Harness` method. The spec names the seam,
  not the mechanism.
- **The TUI's ambient-surface placement.** The webui has status/footer/panel
  places; the TUI has its own idiom (a statusline, a footer, maybe a
  collapsible panel). The builder picks the mapping from the seam's
  `place` field to the TUI's chrome; the seam's records are the contract,
  not the pixels.

## 9. Open questions this design does not answer

- Whether the webui's composer slash-menu logic is extractable into shared
  client code or duplicated in the TUI (a webui/TUI sharing decision, not a
  server one).
- Image/attachment input in the composer (the uploads/files endpoints and
  the `draft.attachments` schema stay a seam; deferred, §4 scope).
- Audio as the third surface (CONTEXT names it) — untouched here.
- Binary publishing and the `npx` story (a follow-up).

## 10. Amendments from builder review

Two review passes shaped this revision. The first (glm-5.3 +
deepseek-v4.1-flash, on the pre-revision draft) found the enumeration and
composer-blocking defects. The second (deepseek-v4.1-flash on the revised
draft, after the interaction/ambient seams landed on main) verified every
load-bearing claim against HEAD and caught four stale references, all fixed
here: `ApprovalSummary` → `InteractionWire` (§4.2), the incomplete endpoint
inventory (§2), and two line-number citations (§3.1 settings.ts:248, §8
boot.ts:268). The second pass's verdict: OK with notes — no design defects.

**Durable conversation enumeration (user's call, and the code backs it).**
The design assumed `GET /v1/conversations` was sufficient. It isn't: the
server's own docstring documents the gap — pi-durable's `Harness` exposes no
conversation enumeration, so the listing is the reserved root plus the ids
the current server process created; a restart forgets the rest, and
cron-created conversations never appear. Meanwhile pi-durable's storage has
`scanConversations` ready to use, and storage is SQLite — the user's point
("aren't they all in a SQLite DB anyway?") is the whole story: the data was
never missing, the surface was. The server adds a `scanConversations`-backed
implementation of `GET /v1/conversations`, so the sidebar (and the webui's
picker, which shares the same defect and is updated in the same pass)
browses *all* durable conversations, not just the in-memory tracked set.
The plumbing is named in §8 (the storage handle lives in `openHarness`, the
route receives `OpenedHarness` — the seam is the accessor's shape, not the
query).

**Composer while a run is live (spec gap, my ruling).** The submissions
endpoint blocks server-side until settlement, so the TUI must fire-and-forget
the submit and trust the SSE stream (§4.2 already made the stream the source
of truth). And pi's idiom is the mandate: type-while-running queues a steer
(`whenBusy` exists on the endpoint), Esc aborts (`POST /v1/conversations/:id/abort`
exists). Both in v1.

The review's other findings are handled in place: §3.1 resolves the
config-file question (the reviewer's sharpest catch — the answer is
"convention, not prohibition"), §8 narrows to the directory/filename choice
and adds the ambient-placement mapping, and §9 records attachments as
deferred. The auth seam (§5) absorbed the fifth finding — the TUI/webui
identity split — by making the client contract uniform. The parity rule
(§1) absorbed the interaction/ambient question that arose after the seam
work landed on main: the TUI renders both, because the webui does.

---

## Design-to-code map (for the plan that follows)

| Design piece | Lands in |
|---|---|
| `sigrun`/`serve`/`attach` entrypoints | `package.json` bin + a thin `src/cli.ts` switch |
| Identity hook (server seam) | one request-hook in `src/server/index.ts` + conversation-create stamping |
| TUI client | `tui/` workspace: `api.ts`, `sse.ts`, `ui/` |
| Interaction + ambient rendering | `tui/` consuming `/v1/conversations/:id/interactions` + `/v1/conversations/:id/ambient` |
| Sidebar/fork/composer | `tui/` over list/create/fork/commands endpoints |
