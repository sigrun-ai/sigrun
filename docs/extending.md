# Extending sigrun: where your extension's stuff goes

This is the contract between sigrun and extension authors. It answers
one question — *where does my extension's stuff go?* — once, uniformly,
so an extension that follows it gets backup-safe persistence,
container-safe cache handling, and secret hygiene without inventing
any of it.

**The anti-example.** Sigrun's reference harness, pi, offers no store
surface: every extension blazes its own path, and the result is
visible on any installed machine — a config directory littered with
per-extension dotfiles, duplicate `snake-case`/`camelCase` variants of
the same config, and ad-hoc state files at the top level. Sigrun's
rule is the opposite: **every file an extension touches lives in a
named bucket, or it doesn't exist.** Nothing at the top level of the
config directory is yours.

**The one-sentence contract:** sigrun gives every extension two
mediated stores (settings, secrets — server-owned files, scoped
get/set through a handle) and three raw stores (data, state, cache —
extension-owned directories), all under XDG-respected roots, keyed by
the extension's slug, resolved by one chain.

## The five stores

| kind | what it is | durability | who writes it | backup |
|---|---|---|---|---|
| **secrets** | credentials, tokens, API keys | durable, sensitive | server-mediated (the handle) | yes (securely) |
| **settings** | user-tunable configuration | durable | server-mediated (the handle) | yes |
| **data** | user-meaningful content the extension produces or ingests | durable | extension (raw files) | yes |
| **state** | operational bookkeeping: cursors, dedup markers, trust stores | durable, meaningless to humans | extension (raw files) | optional |
| **cache** | regenerable derivations: indexes, compiled artifacts, scratch | disposable | extension (raw files) | **never** |

Choosing the right bucket is the author's main design decision, and
the one that matters most is **cache vs. state**: they have opposite
accident profiles. Deleting state silently breaks correctness (a lost
dedup marker re-processes work); deleting cache only costs time. A
single "stuff" bucket would force every backup tool and every purge
story to guess.

## The directory map

| store | sigrun's own files | your extension's surface |
|---|---|---|
| config | `<configDir>/settings.json` | `<configDir>/settings/<slug>.json` |
| secrets | `<configDir>/auth.json` — *provider* credentials | your section in `<configDir>/secrets.json` |
| data | `<dataDir>/sigrun.db` (the harness DB) | `<dataDir>/<slug>/` |
| state | harness bookkeeping | `<stateDir>/<slug>/` |
| cache | — | `<cacheDir>/<slug>/` |

- **`auth.json` is provider credentials only.** Extension secrets
  never go there — they live in `secrets.json`, one top-level key per
  extension slug, contents arbitrary per extension.
- **One settings file per extension** (`settings/<slug>.json`),
  contents entirely your shape. There is no schema language and no
  validation DSL: sigrun stores the object; validating it is the
  extension's job.
- **The data, state, and cache directories are free-form.** Sigrun
  mandates nothing about their contents — not file formats, not
  structure. The surface is "a directory that is yours."
- The config root's other top-level entries are named, not litter:
  `packages/` and `git/` (the extension install machinery), `skills/`
  (your user-wide skills — the same SKILL.md convention the workspace
  ships, listed under the reserved `skills` section for every
  conversation), the identity surfaces `users.json`,
  `api-tokens.json`, and `accounts.json` (mode 0600, sigrun-owned — user
  accounts, token digests, and external-identity links), and channel
  client configs such as `tui.json`.

## One resolution chain — workstation and container

Every root resolves through the same three tiers, per root:

1. **Explicit env** — `SIGRUN_CONFIG_DIR`, `SIGRUN_DATA_DIR`,
   `SIGRUN_CACHE_DIR`, `SIGRUN_STATE_DIR`, used verbatim.
2. **XDG** — `$XDG_CONFIG_HOME` / `$XDG_DATA_HOME` / `$XDG_CACHE_HOME`
   / `$XDG_STATE_HOME` + `/sigrun`, when set and non-empty.
3. **Defaults** — `~/.config/sigrun`, `~/.local/share/sigrun`,
   `~/.cache/sigrun`, `~/.local/state/sigrun`.

An empty env var counts as unset at every tier. For data, cache, and
state, a deployment may also set the settings-file keys
(`server.dataDir` / `server.cacheDir` / `server.stateDir`) between the
env var and the fallback tiers — env wins, then the file, then the
chain. `SIGRUN_STORAGE_PATH` remains the finer DB-file override on top
of the data root (relative values join it; absolute values stay
verbatim).

Containers set no XDG vars — deployments override everything
explicitly. The Helm chart maps the durable buckets onto the PVC
(`SIGRUN_CONFIG_DIR=/data/config`, `SIGRUN_DATA_DIR=/data/data`,
`SIGRUN_STATE_DIR=/data/state`) and **cache onto a pod-local
`emptyDir`** (`SIGRUN_CACHE_DIR=/cache`): regenerable data is exactly
what you don't spend a PVC on, and a scratch directory that
self-cleans on restart is a feature, not a bug. Compose deployments
mirror the shape (cache on tmpfs). For an extension this means one
thing: **treat `paths.cache` as disposable at any moment.**

## Your extension's identity is its slug

Sigrun computes the slug from the name your factory's `extension`
declares, once, at load:

> everything after the last `/` → strip a trailing `@version` →
> lowercase → fold `[^a-z0-9_-]+` runs to a single `-` → trim edge
> `-`/`_`

Worked example: `@juicesharp/rpiv-ask-user-question` →
`rpiv-ask-user-question` (a trailing `@2.0.0` would be stripped the
same way).

- **Scoped names collapse to the last segment by design.** `@a/tool`
  and `@b/tool` share the slug `tool` — the one-fork assumption. Two
  loaded extensions colliding on a slug fails the load loud (the
  second is quarantined, naming both declared names); a name nothing
  survives of (empty slug) fails the same way.
- **The slug is the extension's name everywhere** — the registry key,
  store sections, interaction and ambient records, worker names. It is
  not just a path concern.
- **Renaming changes the slug.** Old directories and store sections
  stay where they were; migrating them is the operator's move, never
  automatic.

## The stores handle

Your package's default export is a factory; if it declares a first
parameter, sigrun calls it with the **host context**. `host.stores` is
the scoped view — the only store surface extension code ever sees:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";

/** An env read with sigrun's ""-means-unset semantics. */
function fromEnv(name: string): string | undefined {
	const value = process.env[name];
	return value === "" ? undefined : value;
}

export default function createAcmeTool(host: {
	readonly stores: {
		/** Your section of secrets.json. */
		readonly secrets: {
			get(key: string): Promise<string | undefined>;
			set(key: string, value: string): Promise<void>;
		};
		/** Your settings/<slug>.json (absent reads as {}). */
		readonly settings: {
			get(): Promise<Record<string, unknown>>;
			set(value: Record<string, unknown>): Promise<void>;
		};
		/** data and state are yours to create; cache exists from the
		 *  first read (sigrun mkdirs it, self-healing after a wipe). */
		readonly paths: {
			readonly data: string;
			readonly cache: string;
			readonly state: string;
		};
	};
}) {
	const { secrets, settings, paths } = host.stores;

	// stored wins, env bootstraps — resolve per use, never memoize the
	// result (see "Secrets precedence")
	const apiKey = async () =>
		(await secrets.get("api-key")) ??
		fromEnv("SIGRUN_EXT_ACME_TOOL_API_KEY");

	// settings: your file, your shape
	const interval = async () => {
		const stored = await settings.get();
		return typeof stored.interval === "number" ? stored.interval : 60;
	};

	// data/state: the ROOT is ensured at boot; your <slug> subdir is not
	const persist = async (index: string) => {
		await mkdir(paths.data, { recursive: true });
		await writeFile(join(paths.data, "index.json"), index, "utf8");
	};

	// cache: read the path, get a directory — never memoize it (an
	// access after a wipe must self-heal)
	const scratch = () => paths.cache;

	return {
		extension: defineExtension({
			name: "@acme/tool", // slugs to "acme-tool"
			sections: [section("acme-note", () => "acme tool loaded")],
		}),
	};
}
```

What the snippet encodes:

- **Secrets and settings are mediated.** You call get/set on *your*
  section and *your* file; you never see a path, and you cannot name
  another extension's slug. Sigrun owns serialization: every write is
  atomic (temp file + rename), `secrets.json` is mode `0600`, settings
  files `0644`. A malformed file — unparseable JSON, or JSON that is
  not an object — fails loud naming the path; it is never silently
  reset.
- **Data, state, and cache are raw.** You own the I/O (fs, sqlite,
  whatever). Sigrun ensures the roots at boot and creates **only**
  your cache directory — lazily, on the first read of `paths.cache`,
  so a wiped cache root (the container `emptyDir` case) never breaks
  boot or your next access.
- **Store calls are safe at any time** — plain file I/O with no
  harness dependency; calling the handle inside the factory body is
  fine. The other surface on the same host — the interaction/ambient
  seams, see [approval-ux-seams.md](approval-ux-seams.md) — binds the
  harness lazily: call those from tool execute or hooks, not from the
  factory body. On that seam, `host.answerInteraction` takes an
  optional `opts?: {user?}`: naming a user answers AS that human
  (`answeredBy: "human"`, `answeredByUser: <user>` — gateway C5);
  omitting it records the extension's own answer.
- **Settings have no env bootstrap.** The store is their only source;
  the env pattern below is for secrets.

## The factory result

The factory's return value is ONE documented contract type, shipped
from the main package as the **types-only** subpath `@sigrun/sigrun/extension`.
Consume it with `import type`, so nothing loads at runtime:

```ts
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";
```

There is no runtime entry behind the subpath — importing it as a value
fails loud by design. Every field is optional; the fields, their types,
what core does with each, and where its rules are documented:

| field | type | what core does with it | documented in |
|---|---|---|---|
| `extension` | pi-durable `Extension` | installed into the registry before `Harness.open`; its declared name is the slug source | this page ("The stores handle", "Prompt sections") |
| `name` | `string` | the identity of a contributor-only result (no `extension`) | "Contributing model providers" |
| `providers` | `readonly ProviderContribution[]` | merged into the boot model catalog; last-registered-wins, collisions recorded and surfaced | "Contributing model providers" |
| `loginProviders` | `readonly LoginProviderContribution[]` | qualified as `login:<slug>:<id>` and mounted on core-owned begin/callback routes | ["Login providers"](#login-providers) |
| `webuiBundles` | `readonly WebuiBundleContribution[]` | each `dir` anchored at the entry; the name-keyed registry `server.webui.bundle` selects from | "Contributing webui bundles" |
| `health` | `() => HealthStatus` | aggregated into `/v1/meta` `health` — any `"degraded"` degrades the surface | "Contributing model providers" |
| `runSettled` | `ExtensionRunSettledHandler` | registered on the event bus; one call per settled run, deadline-bounded | this table |
| `conversationCreated` | `ExtensionLifecycleHandler<"conversationCreated">` | fired when a conversation is created (fork children included) | this table |
| `conversationForked` | `ExtensionLifecycleHandler<"conversationForked">` | fired with the child, parent, and fork point | this table |
| `conversationArchived` | `ExtensionLifecycleHandler<"conversationArchived">` | fired on archive flips (both directions) | this table |
| `conversationIdle` | `ExtensionLifecycleHandler<"conversationIdle">` | fired per quiet period once the idle threshold passes and no run is live | this table |
| `interactionSettled` | `ExtensionLifecycleHandler<"interactionSettled">` | fired once per terminal interaction transition (any writer: route answer, host answer, skip/expire/cancel) with `{conversationId, callId, kind, status}` | [approval-ux-seams.md](approval-ux-seams.md) |
| `harnessShutdown` | `ExtensionHarnessShutdownHandler` | the ordered flush window (handlers may commit); runs after workers stop | this table |
| `userDeleted` | `ExtensionUserDeletedHandler` | fired after a user delete transferred ownership — move your per-user records here | this table |
| `interactionKinds` | `readonly string[]` | gates your interaction-seed writes and feeds the capability inventory | [approval-ux-seams.md](approval-ux-seams.md) |
| `ambientKinds` | `readonly string[]` | gates your ambient-surface writes and feeds the capability inventory | [approval-ux-seams.md](approval-ux-seams.md) |
| `workers` | `readonly ExtensionWorker[]` | host-owned wake timers + one-run-at-a-time execution; statuses in `/v1/meta` | "Idle workers: `wakeOn` only" |
| `jobs` | `readonly JobSpec[]` | declared jobs under `ext:<slug>:<name>` ids; jobs are the only time-based scheduler | "Declaring jobs" |
| `routes` | `readonly ExtensionRouteContribution[]` | HTTP routes mounted at `/v1/ext/<slug>/<path>` | ["HTTP routes"](#http-routes) |
| `commands` | `readonly ExtensionCommandContribution[]` | slash commands merged into `/v1/commands` | ["Slash commands"](#slash-commands) |
| `skills` | `readonly string[]` | absolute skill directories your package contributes (validated: existing dirs; a bad entry quarantines) | ["Skills"](#skills) |
| `notifiers` | `readonly NotifierContribution[]` | notification transports core delivers events to (best-effort, per-recipient) | ["Notifiers"](#notifiers) |
| `channels` | `readonly ChannelContribution[]` | chat-platform adapters the gateway engine drives; channel-id collisions across extensions quarantine the later loader | ["Channel adapters"](#channel-adapters) |
| `gateway` | `GatewayEngine` | the ONE gateway engine (supervises every channel adapter); a second declarer quarantines — and never pair it with `health` | ["Gateway engines"](#gateway-engines) |
| `perUserTools` | `boolean` | permits `host.tools.setUserTools`; core owns the `<slug>@<user>` entries and their execution-time owner check | ["Per-user tools"](#per-user-tools) |
| `userServices` | `readonly UserService[]` | declares per-user service processes; core launches, supervises, and stops them | ["Per-user services"](#per-user-services) |

**The host rule.** The factory's first parameter is the host — `SigrunHost`
above — **never a defaulted options object**. Sigrun passes the host only
when `factory.length > 0`: a factory that wants the host must DECLARE the
parameter, and a length-0 factory may carry a defaulted first parameter
(a real dependency) that would otherwise consume the host and break the
extension at runtime. The host's conversation/identity/access members bind
lazily post-open — call them from tools, hooks, routes, commands, workers,
and jobs, never from a factory body.

A malformed field (wrong shape, wrong element type) quarantines the
extension at load — a package that THINKS it declared something must
never silently lose it.

## The conversation surface

`host.conversations` drives sigrun's own conversations in-process. Every
method runs the SAME op its HTTP route runs
(`src/server/conversation-ops.ts`) — validation, error bodies, and durable
effects are identical by construction:

- `create({owner, sharing, name, source, agent})` — the HTTP `POST
  /v1/conversations` op. The host gains `agent` (gateway C4):
  `{extensions?: string[], tools?: string[]}` pins the conversation's
  selection by NAME, resolved against the installed registry. An unknown
  name throws `invalid_field` (`agent.extensions` / `agent.tools`); an
  empty `tools` array enables zero tools.
- `submit(id, input, {user, requestId, whenBusy})` — the submissions
  route's op (content resolution, the served-model check, `waitMs` off).
- `watch(id, listener)` — the SSE stream's snapshot-first shape.
- `list({owner, archived})` / `meta(id)` — the durable listing and the
  session-meta read (a superuser-shaped view: extensions are trusted).
- `abort(id)` — the abort route's op. On an IDLE conversation it
  resolves (chat `/stop` on an idle chat is not an error); the HTTP route
  keeps its exact 404 `no_active_submission`.
- `configure(id, {model, thinking, extensions})` — the configure route's op
  ("provider/modelId", the thinking-level union, or an exact extension-name
  array). Per-user entries must belong to the conversation's owner.
- `compact(id)` — the manual-compaction route's op (admits the durable
  compaction task; the summary lands as a `pi.compaction` entry).
- `fork(id, {at, owner})` — the fork route's op: `at` defaults to the
  newest entry and is validated against the parent's history;
  `owner` stamps the fork's session owner (absent = the key removed —
  the fork is the forker's private copy, sharing dropped, autoName
  seeded `"<source> (fork)"`).
- `patchMeta(id, {name, archived, sharing})` — the meta PATCH route's
  op. **Trusted-host note:** the sharing patch runs with NO
  owner-or-superuser gate — the caller is in-process server code that
  already decided the write is legitimate. The HTTP route keeps its
  403 for a non-owner; the host carries no principal to check.
- `upload(id, {name, mime?, bytes})` → `{path}` — the raw-upload route's
  op (gateway C4b): writes `uploads/<conversationId>/<name>` through
  the conversation's workspace env and returns the path exactly as a
  `file`/`image` submission part takes it. The NAME is the one rule (no
  `/` or `\`, not `.`/`..`, non-empty) — a bad name throws
  `invalid_field` `name` (the HTTP routes answer their own
  `invalid_body`; the op is the shared validator).
- `readFile(id, path)` → `{bytes, mime?}` — the files/raw route's op
  (gateway C4b): workspace-confined, capped at `server.maxFileReadBytes`,
  with the extension-derived mime (unknown extensions read as
  `application/octet-stream`, the route's own default). A bad path
  throws `invalid_path`, an absent file `not_found`, and an over-cap
  file `too_large` (413; the HTTP route keeps its `file_too_large` +
  `maxBytes` body).

An unknown conversation id throws (`conversation <id> not found`) on
every method — the routes' 404 analog.

## The models and commands surfaces

`host.models.list()` serves the SAME list `GET /v1/models` serves —
picker entries (`id`, `provider`, `modelId`, `name`, `contextWindow`,
`maxTokens`, `reasoning`, `input`, `cost`), no provider internals —
through the one shared construction (helpers `listModels`); the two
surfaces cannot drift.

`host.commands` drives slash commands in-process (chat `/command`
handling):

- `list()` — the merged catalog rows (the core table + extension
  entries; the live skill/template `kind: "expand"` entries are the
  composer's per-request concern, not this surface's).
- `run(conversationId, name, args, {user})` — the invoke route's
  resolution, in-process. An unknown or CORE name throws
  `command_not_found: <name>` (core names drive HTTP endpoints, not
  extension `run`s). The principal is built from the DIRECTORY:
  `opts.user` must name a real user — an unknown user throws
  `unknown user "<user>"` — and becomes `{user, name?, email?, admin:
  <effective>, service: false, method: "host"}`. **Effective admin** is
  the stored flag OR the persisted proxy-group grant (gateway C8 —
  host-side code has no request headers to recompute one). A throwing
  run PROPAGATES (the HTTP route maps 500 `command_failed`; the host
  caller owns its own handling).

## The users surface

`host.users.get/list` serve the directory with **effective admin**:
`admin` is the stored flag OR any stored group in
`server.auth.adminGroups`. The directory stores groups per
authenticating source (`proxy`, `login:<slug>:<id>`); each source's
entry is replaced on its next login or proxy request. Host-side code
(chat commands, channel adapters) reads these stored groups, never
request headers.

The HTTP surface is deliberately different: `/v1/users` keeps `admin`
= the stored flag (the users-admin UI toggles that one), exposes the
deduplicated union as `groups`, and derives `groupAdmin` as
`effectiveAdmin && !admin`. The wire `groupAdmin` is retained for one
release for the users UI; it is never persisted. Group-derived admin
never counts toward the last-admin guard.

Proxy group removal takes effect for host-side checks at that user's
**next web request** (a user who never browses again keeps the stale
stored groups until then).

## The accounts surface

A **link** is one external identity bound to one directory user. Sigrun
keeps every link in ONE table, `<configDir>/accounts.json` (mode 0600,
atomic writes, mtime-reload reads — the same discipline as
`users.json`), because chat senders and login subjects are the same
question: "who is this, in the directory?". A link records `provider`,
`subject`, `user`, `linkedAt`, and `via` (`login`, `self`, `pairing`, or
`admin`).

Provider ids have two forms:

- `chat:<channel>` — a chat sender (the gateway writes these);
- `login:<slug>:<id>` — a login subject, where `slug` is the login
  extension's slug and `id` its provider id (so an extension with slug
  `oauth` contributes ids reading `login:oauth:<id>`).

A subject is opaque to sigrun: a Telegram or Discord numeric id, a
Signal `+E.164` number, and an email-shaped subject all pass — any
non-empty string up to 512 characters.

A provider id is **lowercase, no spaces**: it must match
`^(login|chat):[a-z0-9][a-z0-9._:-]*$`, so `chat:Telegram` is rejected
with `invalid_provider: chat:Telegram`. Use the channel's own, already
lowercase name.

```ts
await host.accounts.lookup("chat:telegram", "12345");   // AccountLinkWire | undefined
await host.accounts.link("chat:telegram", "12345", "alice", "pairing");
await host.accounts.unlink("chat:telegram", "12345");   // boolean
await host.accounts.listForUser("alice");                // readonly AccountLinkWire[]
```

Rules, all enforced by core:

- **One link per `(provider, subject)`.** Re-linking to the SAME user is
  a no-op that returns the existing record. Linking to a DIFFERENT user
  is refused — never silently re-pointed, because re-pointing an
  existing external identity is an account-takeover path. The holder (or
  an admin) removes the old link first.
- **Errors.** An unknown user throws `unknown user "<user>"`; a
  malformed provider id throws `invalid_provider: <provider>`; an empty
  or over-long (513+ characters) subject throws `invalid_subject`; a
  conflict throws an `Error` whose message starts
  `account_link_conflict:` and never names the current holder — match on
  the prefix, as you would on `command_not_found:`.
- **User deletion removes the departing user's links** and never
  transfers them: credentials belong to a person, so the new owner of a
  transferred conversation does not inherit the old owner's chat
  identity.
- **Core owns the file.** Extensions go through `host.accounts`; nothing
  else may write `accounts.json`. Core is the single write path, which is
  what keeps the gateway and the login seam from disagreeing about who a
  sender is.
- **`accounts.json` is in `configDir`**, so the existing `config` backup
  section carries it alongside `users.json`.

Users manage their own links over HTTP, mirroring `/v1/auth/tokens`:

- `GET /v1/auth/accounts` lists the caller's links as
  `{accounts: AccountLinkWire[]}`. A principal with no directory user (a
  userless service token) gets the whole store — the same single-operator
  rule the token list applies. `?user=<name>` is the admin-only window
  into another user's links; naming yourself is allowed and returns the
  same payload as no query. A non-admin naming someone else gets 403
  `forbidden` before the store is read.
- `DELETE /v1/auth/accounts?provider=<p>&subject=<s>` removes one link
  (204). A missing or empty `provider`/`subject` is 400 `invalid_query`;
  an absent link is 404 `unknown_account`; a link belonging to another
  user is 403 `forbidden` unless the caller is an admin.

Both take QUERY parameters rather than path segments because provider ids
contain `:` and subjects may contain `/`, `+`, or `@` (URL-encode them:
`%2B` for a Signal `+E.164` number).

One consequence worth knowing: because a `(provider, subject)` pair is
usually guessable (a Discord handle, an email address), a signed-in
non-admin can tell 404 from 403 and so learn whether a given external
identity is registered — though never to whom. The authorization rule
is checked inside the same serialized mutation as the removal, so a
subject re-linked to someone else mid-request is not removed on the
strength of a stale read.

## Login providers

An extension can prove an external identity by returning `loginProviders`
from its factory. Core owns the browser flow and everything after the
proof; the provider owns only the protocol exchange with the external
identity service.

```ts
import type {
  LoginProviderContribution,
  SigrunExtensionResult,
  SigrunHost,
} from "@sigrun/sigrun/extension";

const company: LoginProviderContribution = {
  id: "company",
  label: "Company SSO",
  icon: "key",                         // optional
  policy: {
    autoProvision: true,
    allowedGroups: ["staff"],
    allowedDomains: ["example.invalid"],
  },
  async begin(flow, ctx) {
    // Keep provider-private values (PKCE verifier, nonce) in flow.data.
    flow.data.verifier = makeVerifier();
    return { redirectUrl: authorizeUrl(flow.state, flow.callbackUrl) };
  },
  async complete(flow, callback, ctx) {
    // callback.query is Record<string, string>; callback.body is unknown.
    const identity = await exchangeCallback(flow, callback);
    return {
      subject: identity.subject,
      profile: {
        username: identity.username,
        name: identity.name,
        email: identity.email,
        emailVerified: identity.emailVerified,
      },
      groups: identity.groups,
    };
  },
};

export default function createLogin(host: SigrunHost): SigrunExtensionResult {
  return { name: "acme-login", loginProviders: [company] };
}
```

The provider id is local to the extension and must match
`^[a-z0-9][a-z0-9._-]*$`; duplicate ids within one extension are invalid.
Core prefixes the extension slug, so this contribution's public provider id
is `login:acme-login:company`. For slug `oauth` and id `company`, it is
`login:oauth:company`.

`GET /v1/auth/login/:provider` calls `begin`, and core redirects the browser
to the returned URL. `flow.callbackUrl` is the callback to register with the
identity service; core accepts that callback by GET or POST at
`/v1/auth/callback/:provider`, then calls `complete` with the same flow and
the callback's query and body. `GET /v1/auth/providers` publishes the id,
label, and optional icon for the sign-in screen.

**Core, not the provider, generates and verifies `state`.** State is
single-use, bound to a separate HttpOnly browser cookie and to the provider.
Core retains `flow.data` in memory for 10 minutes and passes it back to
`complete`; a restart invalidates an in-flight login. Core also owns the
callback route, first-login resolution, provisioning policy, session
creation and cookie, and stored groups. The provider only builds the authorize
URL and turns its callback into `{subject, profile, groups}`. The subject
must be stable within that provider; matching usernames or emails never
implicitly links an existing sigrun user.

The optional `policy` fields are declarations **core enforces within their
provisioning scope**, not checks the provider must repeat:

- `autoProvision: true` admits a previously unlinked subject without an
  invite, subject to the filters below. Its default is `false`, which
  requires an invite after the first claim.
- `allowedGroups` requires at least one named group in the login result.
- `allowedDomains` requires an email in one of the listed domains **and**
  `profile.emailVerified === true`. An absent or unverified email never
  satisfies this filter.

**The two filters apply only when auto-provisioning a NEW user.** They do
not filter subsequent logins by an already-linked account, and they do not
apply to invite-based provisioning. A linked account keeps working even if
it no longer satisfies a changed filter; removing that account's access
requires removing its link (or the user).

**Groups have a narrow trust boundary.** Core accepts groups only from a
login result or from proxy headers that passed trusted-peer validation and
any configured secret validation. With execution isolation on, the proxy
shared secret is mandatory; see the M1 isolation requirements in the
operator documentation. A token- or session-authenticated request only reads
groups already stored on the user; nothing in that request can set or add them.
Each source replaces its own stored entry at the next login or proxy
request, so changes at the identity service deliberately take effect then,
not continuously. Stored groups participate in effective-admin and
group-sharing checks.

Login-provider groups participate in `server.auth.adminGroups`, so configure
only providers whose group claims are administrator-controlled. A linked
account's groups come from the provider at each sign-in; removing admin
therefore requires changing the provider's claim or removing the link/user.

Login-provider validation is all-or-nothing for one extension: a malformed
array or entry, an invalid or duplicate id, a non-string label/icon, or a
non-function `begin`/`complete` quarantines that extension. Boot continues
without its login providers.

The `@sigrun/oauth` package implements this contract for OIDC and OAuth 2.
It is the fourth built-in extension: bundled and loaded by default.
`builtinExtensions.oauth: false` disables it (restart-required), and a
configured extension with the same package name replaces it. An unresolvable
or failed built-in is quarantined rather than aborting boot. The package can
still be installed separately for a deployment that wants it without the
built-in. See [Authentication](README.md#authentication) for its operator
configuration.

## Secrets precedence: stored wins, env bootstraps

For every secret, the resolution order is:

1. the **stored** value — your `secrets.json` section has the key;
2. else the **env var** `SIGRUN_EXT_<SLUG>_<KEY>` — slug and key
   uppercased, `-` folded to `_`;
3. else undefined.

Worked example — the extension above (slug `acme-tool`), key
`api-key`:

```bash
export SIGRUN_EXT_ACME_TOOL_API_KEY=sk-...
```

- **Env values are never written down.** A boot that resolves a
  secret from env leaves `secrets.json` byte-identical; the write
  path is the handle (and future server affordances) alone.
- **Once a value is captured into the store by any channel — your own
  `secrets.set`, the webui settings panel (coming with the
  settings-surface work), or any future channel affordance — the
  stored value wins from then on**, without a restart: every `get`
  reads the file fresh, so a mid-flight capture is visible to the
  next call. The precedence rule is fixed now so affordances can land
  later without changing extension code.
- The name conversion is mechanical: uppercase, `-` → `_`. A
  camelCase key such as `apiKey` maps to `APIKEY` (no separator is
  invented), so prefer kebab-case or snake_case keys.
- An empty-string env var counts as unset — the same
  ""-means-unset reading the directory tiers use.

## Contributing model providers (provider plugins)

An extension package can contribute pi-ai providers — dynamic catalogs
that boot merges, refreshes, persists, and serves on `/v1/models` —
without any pi-durable surface at all. The factory result carries a
`providers` array of contributions; **a result with `providers` and no
`extension` is a valid provider-only contributor** identified by its
`name` field (which must equal the package name for factory-time scoped
settings reads to resolve — see below):

```ts
import { createProvider } from "@earendil-works/pi-ai/models";

export default async function sigrunAcme(host: {
	readonly stores: {
		readonly settings: {
			get(): Promise<Record<string, unknown>>;
		};
	};
}) {
	const settings = await host.stores.settings.get();
	// ...build the provider (see the rules below)...
	return {
		name: "sigrun-acme",
		providers: [{ provider, readiness }],
		health, // optional, "ok" | "degraded"
	};
}
```

The contract rules, all load-bearing:

- **Baseline `models: []`.** `createProvider` requires the field
  (omitting it throws); an empty array is the purely-dynamic shape and
  boots with an empty catalog the refresh fills.
- **Stamp `provider: "<your-id>"` on every model `fetchModels` returns.**
  pi-ai's restore path drops persisted models whose `provider` differs
  from the registered id, so an unstamped catalog silently vanishes on
  the next cold boot.
- **`fetchModels` throws, never returns `[]`.** The createProvider
  wrapper publishes and persists whatever the fetch returns — an empty
  array would wipe the catalog and the persisted store. Unconfigured,
  unreachable, or garbage upstreams throw (the refresh retains the last
  known catalog by contract).
- **`readiness` is the three-state tracker** sigrun's `/v1/auth/check`
  reports verbatim: `not_configured` (no credential resolved — an
  unconfigured optional plugin, not a broken process), `degraded`
  (credential resolved, last refresh failed), `ready` (credential
  resolved, refresh succeeded or a static catalog serves). Seed it from
  credential resolution — pi-ai never refreshes an unconfigured
  provider, so refresh outcomes alone cannot express `not_configured` —
  and update it per refresh outcome. It must be a synchronous read over
  plugin-owned state: never network, never storage.
- **Without a tracker**, `/v1/auth/check` falls back to the legacy
  producer mapping: `ok` → `ready`, `degraded` → `invalid`, absent →
  `not_ready`. The three-state vocabulary applies only to tracker-backed
  providers.
- **Credentials resolve through the auth bridge, never your own I/O.**
  The stored credential arrives as `credential` on your auth resolver
  (auth.json's `"default"` entry first, then your provider's own — sigrun
  reads it for you); ambient env arrives via `ctx.env(NAME)`. Do not
  read `auth.json` or `process.env` yourself. Resolve `undefined` when
  nothing is configured — pi-ai then skips the refresh phase and
  requests fail loud instead of boot failing.
- **Scoped settings are restart-required.** Whatever your factory reads
  from `host.stores.settings` is baked into the provider at factory
  time; changing `settings/<slug>.json` applies on the next restart, not
  mid-run. (The loader pre-keys the factory host on the slug derived
  from your package name, so a factory-time read resolves your file
  when the declared `name` matches the package name.)

**Dependency posture.** Host modules you import at **runtime** —
`@earendil-works/pi-ai`, `@earendil-works/pi-durable`,
`@earendil-works/chord`, `@sigrun/shared` (whose types the
`@sigrun/sigrun/extension` contract references), and `typebox` (pi-ai's
own dependency) — are declared as **exact-pinned peerDependencies,
mirrored in devDependencies**: the peer pin equals the version sigrun
itself depends on, and the devDependency reproduces that exact version
(or the workspace `file:` shape during development). Sigrun ships them
at runtime, the packages-dir install omits dev dependencies, and the
loader links the host's own copies into the packages dir so your bare
imports resolve — you consume the SAME module instances the host runs,
matched structurally at runtime (never by `instanceof`).
`@sigrun/sigrun` itself follows the import kind: declare it a
**`peerDependency: `"*"`** (never a dependency and never a pinned range)
**only** if you import runtime code from `@sigrun/sigrun/blocks`;
type-only consumers declare it a **devDependency** and never a peer.
Sigrun links its own running package into the packages dir the same way,
and the loader quarantines an extension whose tree resolves a DIFFERENT
sigrun — the builders behind `@sigrun/sigrun/blocks` must emit the
server's block-set version, which only the running copy does. Import the
builders from `@sigrun/sigrun/blocks`:

```ts check
import { bind, card, collection, page, tree } from "@sigrun/sigrun/blocks";
import type { Tree } from "@sigrun/sigrun/blocks";

export function board(): Tree {
	return tree(
		page({
			title: "Board",
			main: [
				collection({
					id: "cards",
					items: bind("/cards"),
					display: "lanes",
					item: card({ title: bind("./label") }),
				}),
			],
		}),
	);
}
```

Reference plugins: [sigrun-provider-ollama](https://github.com/sigrun-ai/sigrun-provider-ollama)
(the minimal shape), [sigrun-provider-opencode](https://github.com/sigrun-ai/sigrun-provider-opencode),
[sigrun-provider-pareto](https://github.com/sigrun-ai/sigrun-provider-pareto) (scoped-settings
base URL), and [sigrun-provider-bifrost](https://github.com/sigrun-ai/sigrun-provider-bifrost)
(multi-surface discovery).

## Contributing webui bundles

An extension can ship a replacement web UI as a **contributed bundle**: a
factory-result field, the same contributor pathway as `providers`. The
result carries a `webuiBundles` array of `{ name, dir }` entries —

```ts
import { defineExtension } from "@earendil-works/pi-durable";

export default function createAcmeWebui() {
	return {
		extension: defineExtension({
			name: "@acme/webui", // slugs to "acme-webui"
			sections: [],
		}),
		webuiBundles: [{ name: "acme-webui", dir: "../webui" }],
	};
}
```

- **`name` is the selection key** and must match `^[a-z][a-z0-9_-]*$`
  (lowercase first letter, then lowercase letters, digits, `-`, `_`).
  It is INDEPENDENT of your extension slug — any string in the grammar
  is yours to pick — but naming it after your own slug (as the example
  does for readability) is the most collision-prone choice under
  last-registered-wins: a co-installed replacement extension reusing
  that name silently shadows your bundle (a warned, recorded collision
  — see `/v1/meta` `collisions.webui`). Prefer a distinctive name.
  A malformed `webuiBundles` field — not an array, a name outside the
  grammar, a missing or empty `dir` — **quarantines the extension at
  load**, fail-loud: a package that thinks it contributed a bundle must
  never silently lose it.
- **`dir` is the bundle root** — the directory containing `index.html`
  and its assets — and a relative value resolves against the
  **extension ENTRY FILE's directory**, your package, never the
  server's cwd. The npm footgun: a package whose entry is
  `dist/index.js` anchors at `<pkg>/dist`, so a bundle shipped at
  `<pkg>/webui` is `"../webui"` (or build the bundle under `dist/`
  beside the entry and say `"./webui"`). Absolute dirs pass through
  verbatim.
- **The server owns the `index.html` check.** A contributed bundle
  lacking `index.html` fails at SERVE time with a boot error naming
  your extension — not at load; the loader stays filesystem-free by
  contract.
- **Name collisions are last-registered-wins** with a `console.warn`
  and a retained record surfaced at `/v1/meta` under `collisions.webui`
  — a co-installed replacement bundle is a deployer-visible choice,
  never a silent shadowing.
- **Selection is configuration, resolved at serve time** (contributed
  bundles only exist after extensions load): set the selector to your
  name — `server.webui.bundle: "acme-webui"` or
  `SIGRUN_WEBUI_BUNDLE=acme-webui`. An explicit name that matches no
  contributed bundle is a boot error naming it. The gate applies first:
  `server.webui.enabled: false` (`SIGRUN_WEBUI=false`) mounts nothing
  at all, contributed or built-in.
- **A selected contributed bundle mounts exactly like the built-in
  one** — same static + SPA-fallback seam, `/v1/*` API precedence
  unchanged, no separate service or port — and `/v1/meta`'s
  `capabilities.channels` reports the selected bundle's name
  (`"webui"` for the built-in default and explicit paths, your `name`
  for yours), so a client can identify the UI it is talking to.
- **A bundle-only contributor needs a `name`.** As with `providers`, a
  factory result carrying `webuiBundles` and no `extension` is a valid
  contributor — identified by its `name` field.

## The listener block in `GET /v1/meta`

`GET /v1/meta` carries a `listener` object — `{host, port, families}` —
reporting the ONE listen host the server resolved (`serve({host})` →
`SIGRUN_LISTEN_HOST` → the `::` default) and the address families the
live listener accepts (measured once at listen, retained, never probed
per request). A hostname or wildcard `host` is the configured string,
never a resolved peer address.

`listener` is a required field in the shared `MetaResponse` type, but an
**additive** wire field: servers up to 0.2.0 omit it entirely. If your
extension or client consumes it, tolerate its absence (a mixed-version
upgrade briefly serves the old shape) — treat a missing `listener` as
"unknown", never as a bind failure.

## Declaring jobs (the only time-based scheduler)

A factory result may declare `jobs` — scheduled work sigrun runs for you,
surviving restarts:

```js
export default function createMyExtension() {
	return {
		extension: defineExtension({ name: "acme" }),
		jobs: [
			{
				name: "nightly-prune",                    // ext:acme:nightly-prune
				schedule: { cron: "0 3 * * *" },          // or { every: "15m" } / { at: "<ISO>" }
				action: { kind: "task", task: "prune" },  // a task YOUR extension registers
			},
		],
	};
}
```

Each entry is a full job spec (the §8.2 grammar of the core design doc:
`name`, exactly one of `cron`+optional `timezone` / `every` / `at`, and a
`prompt` or `task` action). Extension-declared jobs are read-only through
the API — edit the extension to change them. A malformed declaration
( bad grammar, duplicate names) quarantines the extension at load.

A `prompt` action may carry `deliver: string[]` — gateway delivery
targets (spec §8.0 C7): an optional array of 1–8 strings, each 1–256
chars, valid ONLY with `conversation: "new"` (a conversation bound to
a chat already delivers there). Core validates the SHAPE only — the
target grammar belongs to the loaded gateway engine, not core. When
the fire runs, `fire.ts` stamps `deliver` plus the owning `jobId` into
the run conversation's SessionMeta (both server-owned: a meta PATCH
carrying either key is a 400 `invalid_field`), and the gateway's
runSettled delivery reads the stamp to route the answer to chats. Two
behaviors follow: editing `deliver` is a job revision (the field rides
`specHash`), and a fire with `deliver` while NO engine loaded logs one
`deliver targets ignored: no gateway` warning per run (visible, never
silent). The warning fires on the creating fire only — a crash-recovered
re-entry (the run record already carries its conversation) re-runs the
submit without re-warning.

## HTTP routes

A factory result may declare `routes` — HTTP endpoints sigrun mounts at
`/v1/ext/<slug>/<path>` (webhooks, OAuth callbacks) using web-standard
`Request`/`Response` (Node ≥ 22; no server type crosses the contract):

```js
routes: [
	{
		method: "POST",            // GET | POST | PUT | PATCH | DELETE
		path: "webhook",           // RELATIVE: no leading "/", no ".."
		auth: "public",             // "user" | "admin" | "public"
		bodyLimit: 262144,         // optional; default 1 MiB
		async handler(request, ctx) {
			// ctx.principal is present on user/admin routes, absent on public
			return new Response(await request.text(), { status: 200 });
		},
	},
]
```

- **`public` skips authentication only** — the Host/Origin checks and
  the unclaimed-server gate still apply, and no principal is attached.
  The handler verifies its own caller (a webhook signature, an OAuth
  `state`). `user` routes require a credential; `admin` additionally
  requires an admin principal (403 otherwise).
- The handler receives a fresh `Request` per call, its URL absolute
  (`server.publicUrl` / `SIGRUN_PUBLIC_URL` when set, else
  `http://<Host header>`); its body may be read **once** per the web
  standard (a second `text()` rejects).
- Return a `Response` (or throw): a throw or a non-`Response` return
  answers `500 {error: "extension_route_failed", extension}` — logged,
  never a crash.
- A body over `bodyLimit` (default 1 MiB) answers `413 too_large`.
- A malformed declaration (bad verb, escaping path, unknown `auth`)
  quarantines the extension at load.
- `server.publicUrl` (`SIGRUN_PUBLIC_URL`, settings `server.publicUrl`)
  is the deployment's absolute base URL — trailing slashes are
  stripped; without it, notification deep links are omitted.

## Slash commands

A factory result may declare `commands` — slash commands that appear in
the clients' `/` menu (`GET /v1/commands` merges them after the core
table). Unlike core commands, an extension command executes ON THE
SERVER: the client POSTs the invoke route and renders the returned
notice (a transient banner in the webui, a status-bar flash in the TUI).

```js
commands: [
	{
		name: "standup",        // ^[a-z][a-z0-9-]*$; core names reserved
		description: "Post today's standup summary",
		args: "[team]",           // optional argument hint for the / menu
		async run(ctx) {
			// ctx: { conversationId, args, principal, host }
			// args is the raw text after the command word ("" when absent)
			return { notice: "posted" };   // {notice?} — optional
		},
	},
]
```

- The invoke endpoint is `POST /v1/conversations/:id/commands/<name>`
  with body `{args?: string}` — **write-gated** (a read-only sharee gets
  403; the conversation must exist, else 404).
- `ctx.host` is the same seam host `routes` receive; `ctx.principal` is
  the caller.
- A throw answers `500 {error: "command_failed", extension}` naming
  your slug — logged, never a crash.
- **Core command names are reserved** (`new`, `fork`, `compact`,
  `export`, `import`, `name`, `model`, `thinking`, `jobs`): a command
  naming one is DROPPED at boot with one warning — it never appears in
  the menu and invoking its name is 404.
- Two extensions declaring the same name: **last-registered-wins**
  (load order), warned at boot and recorded in `GET /v1/meta`
  `collisions.commands` — a co-installed replacement is a deployment
  choice the operator can see, never a silent shadowing.
- A malformed declaration (bad name shape, missing `description`,
  non-function `run`) quarantines the extension at load.

## Interactions: a pending human decision is a block tree

An **interaction record** is how your extension says "this conversation
is waiting on a human decision" and receives the answer durably
([approval-ux-seams.md](approval-ux-seams.md)). Its **body is a block
tree** — placement `interaction`, a root `form` whose submit IS the
answer — built with the typed builders from `@sigrun/sigrun/blocks`
(the host-linked copy; `tree()` stamps the server's block-set version,
so never bundle your own). Declare every kind you seed in the factory
result's `interactionKinds`; seeding an undeclared kind throws at the
write. The envelope (kind, callId, status, timestamps, answer) is
core-owned; channels render the tree generically with no per-extension
UI.

An allow/deny gate (the pi-warden shape — a toned `choice` and a
`longtext` reason, with `markdown` context above the decision section;
a form's direct children are fields and `section`s, so prose blocks
group inside a section):

```ts check
import { choice, form, longtext, markdown, section, tree } from "@sigrun/sigrun/blocks";
import type { Tree } from "@sigrun/sigrun/blocks";

export function gatingConfirmBody(command: string, reason: string): Tree {
	return tree(
		form({
			id: "confirm",
			bind: "/values",
			mode: "submit",
			submitLabel: "Send",
			children: [
				section({
					title: "Confirm",
					children: [
						markdown({ text: `About to run \`${command}\` — it matched a confirm rule.` }),
					],
				}),
				section({
					title: "Decision",
					children: [
						choice({
							name: "decision",
							label: "Allow this call?",
							options: [
								{ id: "allow", label: "Allow", tone: "good" },
								{ id: "deny", label: "Deny", tone: "bad" },
							],
						}),
						longtext({ name: "reason", label: "Why (optional)", placeholder: reason }),
					],
				}),
			],
		}),
	);
}
```

A multi-question form (the ask-user-question shape — one `section` per
question, per-option `preview` markdown, `allowOther` for free text):

```ts check
import { choice, form, section, tree } from "@sigrun/sigrun/blocks";
import type { Tree } from "@sigrun/sigrun/blocks";

export function questionsFormBody(): Tree {
	return tree(
		form({
			id: "ask",
			bind: "/values",
			mode: "submit",
			children: [
				section({
					title: "Pick a store",
					children: [
						choice({
							name: "store",
							label: "Which store should the extension use?",
							multi: false,
							allowOther: { label: "Something else" },
							options: [
								{
									id: "sqlite",
									label: "SQLite",
									description: "A single file under your data dir",
									recommended: true,
									preview: "**SQLite**: zero setup, durable, local-only.",
								},
								{
									id: "markdown",
									label: "Markdown files",
									preview: "**Markdown**: greppable, versionable by hand.",
								},
							],
						}),
					],
				}),
			],
		}),
	);
}
```

**The answer is `{values}`** (ruling 20): when a human submits, the
generic answer route (`POST /v1/conversations/:id/interactions/:callId/answer`,
body `{values}`) writes `answer: { values: { <field name>: value } }`
onto the record — every field's value under its name; a `choice` value
is its option id (or ids when `multi`), a `choice` with `allowOther`
carries `{ other: "…" }`. Your poll loop reads `record.answer?.values`
via `host.snapshotInteraction`; `host.answerInteraction` (extension-side
answer) takes the same `{values}` shape. A `secret` field's value
reaches your `snapshotInteraction` read once — the stored record keeps
only `"[secret]"` (there is no answer handler; your poll loop reads the
live answer envelope) — and channels and logs never see it (the settled
event carries no answer values). First answer wins: a second answer gets
`404 not_pending`.

## Ambient surfaces: persistent read-mostly state as a block tree

An **ambient surface** is the other direction — keyed, persistent,
read-mostly state (a statusline slot, a footer zone, a panel) you
REPLACE wholesale, never block on. Same discipline: strict core-owned
envelope (`key`, `place`, `maxRows?`, `overflow?`, `refreshMs?`,
`expires`, `updatedAt`) around a **block-tree body** (placement
`ambient`) built with the same builders. Declare every key in
`ambientKinds`. `place: "status"` and `"footer"` allow ONE line — a
single one-line `markdown`, or one `columns` of one-line blocks (the
footer's left/middle/right zones are three columns); validation rejects
anything taller. A footer with the three zones:

```ts check
import { columns, markdown, tree } from "@sigrun/sigrun/blocks";
import type { Tree } from "@sigrun/sigrun/blocks";

export function footer(left: string, middle: string, right: string): Tree {
	return tree(
		columns({
			children: [
				{ block: markdown({ text: left }) },
				{ block: markdown({ text: middle }), weight: 1 },
				{ block: markdown({ text: right }) },
			],
		}),
	);
}
```

`expires` and `updatedAt` are host-assigned envelope fields — the host
stamps them on the record; you never pass them to `setAmbient`. The
envelope may also carry `details?` (opaque JSON the channel renders as
one collapsed line, never interpreted).

A statusline slot and a panel of rows (the rpiv-todo shape — a
`collection(display: "list")` of literal rows; ambient bodies bind
nowhere outside a collection's item template — the envelope carries no
data model):

```ts check
import { bind, card, collection, markdown, tree } from "@sigrun/sigrun/blocks";
import type { JsonValue, Tree } from "@sigrun/sigrun/blocks";

export function statusline(text: string): Tree {
	return tree(markdown({ text }));
}

export function todoPanel(rows: readonly JsonValue[]): Tree {
	return tree(
		collection({
			id: "todos",
			items: rows,
			display: "list",
			item: card({
				title: bind("./label"),
				status: { label: bind("./status"), spinner: bind("./running") },
			}),
		}),
	);
}
```

Write with `host.setAmbient(conversationId, { key, place, body }, context)`
from a tool execute or hook (never the factory body); clear with
`host.clearAmbient`. One slot key is owned by exactly one extension —
allocation, not silent composition.

## Idle workers: `wakeOn` only

A factory result may also declare `workers` — in-process handlers woken
by conversation lifecycle events (a curator reacting to
`conversationIdle`):

```js
workers: [
	{
		name: "curator",
		wakeOn: ["conversationIdle"],   // REQUIRED, non-empty
		async run(context, wake) { /* … */ },
	},
]
```

**`every` is retired** (2026-10-19, ruling 12): a worker declaring
`every` quarantines its extension with `workers.every was retired —
declare a job with a task action`. Jobs are the only time-based
scheduler; an extension that needs a timer declares a job with a `task`
action (see above). Workers keep their run deadline, queued+coalesced
wakes, and the `/v1/meta` status projection.

## Prompt sections: six keys are reserved

pi-durable composes the system message from **sections** — a key plus
a render function — declared on every loaded extension, in registry
install order. Core installs its own extensions before `Harness.open`
reads the registry, so core sections lead the prompt; the per-model
guidance extension installs last, so its sections trail. The
`acme-note` section in the snippet above is one of yours; six keys are
core-owned surface:

| key | owned by | what renders |
|---|---|---|
| `identity` | `sigrun.context-files` | static identity paragraph (runtime facts) |
| `persona` | `sigrun.context-files` | `SOUL.md`, else the shipped default persona |
| `workspace-instructions` | `sigrun.context-files` | `AGENTS.md` from the conversation cwd (absent file → section omitted) |
| `skills` | `sigrun.skills` | the three-root skill list (see [Skills](#skills)) |
| `tool-guidance` | `sigrun.model-guidance` | per-model tool guidance |
| `execution-guidance` | `sigrun.model-guidance` | per-model execution guidance |

The registry itself permits duplicate section keys across extensions
(last writer wins at render), so a loaded extension could silently
replace a core surface. The loader quarantines instead: any extension
declaring a reserved key fails its LOAD — boot continues without it,
`GET /v1/meta`'s `extensions[].status` reports the quarantine — with
the message

```
extension "<name>" declares reserved core section "<key>"
```

naming your extension and the key. Sections under any non-reserved
key are yours, freely; there is no registration and no schema.

Two of the reserved keys carry a convention worth knowing even if you
never declare a section yourself:

- **Per-model guidance keys off the request's model string.** Core's
  model-guidance extension resolves `tool-guidance` and
  `execution-guidance` from an ordered, first-match-wins table of
  substrings matched case-insensitively against the request's resolved
  `${provider}/${modelId}` (table strings are lowercase by convention).
  For an unmatched model both sections render absent — the designed
  empty case, not an error. Section renderers have no `Models` catalog
  access: `PromptInput.agent.model` is the only model input, so a
  model-keyed section of your own keys off the same string.
- **Persona replacement is wholesale.** A present `SOUL.md` — including
  an empty file — owns the `persona` section outright, and an absent
  `SOUL.md` (or no env) renders the shipped `DEFAULT_PERSONA`. The
  default is never merged with a user file.

## Skills

The reserved `skills` section (owned by the core `sigrun.skills`
extension) lists skills from THREE roots, first-wins in this order:

1. **the workspace** — `skills/<dir>/SKILL.md` under the conversation's
   workspace;
2. **the user dir** — `<configDir>/skills/<dir>/SKILL.md`, your
   deployment-wide skills (a named config-root entry; no extension
   involved);
3. **package roots** — skills your package ships, in `extensions[]`
   install order.

A name present in several roots keeps the higher root's copy and logs
the shadowing. `load_skill` serves the winning copy.

A package ships skills either through its manifest —

```json
{
  "name": "my-skill-pack",
  "sigrun": { "skills": ["./skills"] }
}
```

(the pi-compat `pi.skills` spells the same thing) — or through the
factory-result `skills` field (absolute directories, useful when the
dirs only exist at runtime). Manifest dirs resolve against the package
root; nonexistent entries are dropped. A package that declares skills
and ships **no loadable entry** is a valid **skills-only** package:
outcome `ok`, nothing imported — this is how
`git:github.com/obra/superpowers` loads (its only pi extension is
TypeScript, which plain node cannot import; each `.ts` pi entry is
skipped with one warning). A package that declares an entry which does
not resolve still quarantines.

The rendered section is capped at `skills.sectionMaxBytes` (default
4096, a live setting) with a truncation notice.

## Prompt templates

A package may also ship **prompt templates** — the `/name` commands
whose bodies are Markdown files — through a conventional `prompts/`
directory at the package root:

```
my-package/
  package.json
  prompts/
    review.md      → /review
    deploy.md      → /deploy
```

No manifest field is needed: any `prompts/` directory at an installed
package's root is discovered (attributed to the package, in
`extensions[]` install order). Template files are direct `.md`
children only; frontmatter `description` (else the first non-empty
line) feeds the `/` menu and optional `argument-hint` hints the
arguments. Templates substitute shell-quoted arguments
(`$1`, `$@`, `${1:-default}`, `${@:N}`, `${@:N:L}`) and are expanded
server-side at admission — see README's “Skills and prompt
templates”. The user dir `<config-dir>/prompts/` and the workspace's
`prompts/` are the other two roots, with the same workspace > user >
packages precedence as skills; a template whose name collides with a
core or extension command is skipped with one warning.

## Notifiers

A factory result may declare `notifiers` — transports core delivers
events to. **Core ships none**: every transport (ntfy, Signal, web
push, ...) lives in an extension.

```js
notifiers: [
	{
		name: "ntfy",
		async notify(event, ctx) {
			// ctx.host is your seam host; event is one notification
			await fetch(`https://ntfy.example/${event.user ?? "sigrun"}`, {
				method: "POST",
				body: `${event.title} — ${event.body}`,
			});
		},
	},
]
```

Core emits one event per **recipient** (`user` is who it is for):

```ts
{
	type: "interaction.pending" | "job.failed" | "run.settled",
	conversationId?: number,   // the conversation, when one is involved
	jobId?: string,            // the failed job's id
	callId?: string,           // the pending record's id — interaction.pending ONLY
	user: string | undefined,  // the recipient
	title: string,
	body: string,
	url?: string,              // `${server.publicUrl}/#/c/<id>` when set
}
```

- **Emitted events.** `interaction.pending` — always (an agent needs a
  human); it carries the record's `callId` so a notifier can read the
  record via `ctx.host.snapshotInteraction` (the only type that carries
  it). `job.failed` — always, once per failed run. `run.settled` —
  per the `notifications.runSettled` setting: `"unwatched"` (default)
  only when no client stream is attached to the conversation (the
  away-from-desk case), `"cron"` only for job-run conversations,
  `"always"` every settle, `"never"` none. The setting is live — a
  `settings.json` PATCH reaches the next settle without a restart.
- **Recipients.** Each event goes to the resource's owner. For
  `interaction.pending` it also goes to every directory user with
  `write` access — anyone who can answer.
- **Titles.** `interaction.pending` → `"Sigrun needs you"` with the
  conversation's display name; `job.failed` → `"Job <name> failed"`
  with the run's error; `run.settled` → `"Reply ready"` with the
  display name. The display name is `name ?? autoName ??
  "Conversation <id>"`.
- **Delivery is best-effort.** Each `notify` call runs deadline-bounded
  on the event bus's side lane; a throwing or over-deadline notifier is
  logged and isolated — the other notifiers still receive the event —
  and nothing is retried durably (reliability is a notifier's own
  concern).
- A malformed declaration (missing name, non-function `notify`)
  quarantines the extension at load.

## Channel adapters

A factory result may declare `channels` — chat-platform adapters
(Telegram, Signal, Slack, IRC, a loopback test harness, ...) the
gateway engine drives. **Core ships no engine and no adapters**; each
lives in its own extension package, and a `channels`-only result is a
valid contributor identified by its `name` (the `providers` rule).

```js
export default function acmeChannel(host) {
	return {
		name: "acme-channel",
		channels: [
			{
				id: "acme",
				label: "Acme Chat",
				capabilities: {
					chatTypes: ["dm", "group"],
					maxMessageLength: 4096,
					format: "markdown",
				},
				async configured() {
					const token = await host.stores.secrets.get("bot-token");
					return token === undefined
						? { status: "not_configured" }
						: { status: "ready" };
				},
				async start(ctx) {
					// connect; hand every platform message to ctx.receive(event)
				},
				async send(message) {
					// returns { messageIds: [...] }
				},
			},
		],
	};
}
```

The full type shapes (`ChannelContribution`, `ChannelCapabilities`,
`InboundEvent`, `OutboundMessage`, ...) are the spec §7 contract in
`@sigrun/sigrun/extension`. Rules for adapter authors:

- **Webhook transports** (Telegram, Slack callbacks) declare their own
  `routes` — mounted at `/v1/ext/<adapter-slug>/...` with
  `auth: "public"` — and hand events to the `ChannelContext` captured
  in `start`, verifying the platform's signature themselves. A webhook
  arriving before `start` or after `stop` answers `503` — the engine's
  contract, not yours to implement.
- **Socket/poll transports** run their receive loop from `start`, never
  from the factory body (the pi lifecycle lesson: timers and sockets
  belong to started surfaces, and a quarantined replacement must not
  leave them running).
- **Credentials come from your own host stores.** Resolve
  stored-then-env yourself — `host.stores.secrets.get(key)`, else
  `SIGRUN_EXT_<SLUG>_<KEY>` from `process.env` ([the secrets-precedence
  rule](#secrets-precedence-stored-wins-env-bootstraps)). The engine
  never sees credentials. `configured()` reports whether they are
  present; unconfigured adapters are never started.
- **Button `data` is an engine-issued token of at most 64 bytes**
  (Telegram's callback limit, the tightest seen). Pass it through
  verbatim — never interpret, never persist it as meaning.
- **Oversized media is refused by name, not by class.** When an
  attachment's `fetch(opts)` exceeds `opts.maxBytes`, stop reading and
  throw an error whose `name` is `"AttachmentTooLarge"` — the engine
  matches that name, never `instanceof` (the contract is types-only;
  there is no runtime class to share).
- **`format` is required when `capabilities.format` is `"native"`** —
  native markup has no default renderer.
- **Channel ids are global.** Two loaded extensions declaring the same
  channel id quarantine the *later* one, naming both — deliberately
  unlike the last-registered-wins rule for commands and bundles, because
  chat bindings are keyed by channel id and a shadowing adapter would
  inherit another adapter's chats. Duplicate ids within one result
  reject the same way.
- A malformed declaration (bad id grammar, empty `label`, non-function
  `start`/`send`/`configured`, a `capabilities` that fails the shape
  check) quarantines the extension at load.

`GET /v1/extensions` lists each row's contributed channel ids under
`channels`.

## Gateway engines

A factory result may declare `gateway` — the engine that supervises
every channel adapter. **One engine per boot**: the first declarer
wins; a later extension declaring `gateway` quarantines at load with
`gateway engine already declared by "<first slug>"` (an engine owns
supervision over the whole channel set — never last-wins). Core ships
no engine of its own in the loader, but the **built-in `gateway`
extension** (`@sigrun/ext-gateway`, the fourth built-in alongside
codemode, MCP, and tool search) is exactly that engine: installed as a
core dependency, enabled by default, disableable with
`"builtinExtensions": {"gateway": false}`. With the built-in disabled
(or replaced), adapters without a loaded engine are inert (below).

Operators configuring channels, pairing, groups, job delivery, or
shutdown should read the
[@sigrun/ext-gateway operator guide](https://github.com/sigrun-ai/sigrun-ext-gateway#readme).

```js
export default function acmeEngine(host) {
	return {
		extension: defineExtension({ name: "acme-gateway-engine" }),
		gateway: {
			async start(ctx) {
				// ctx.channels: every loaded adapter's {extension, channel}
				// ctx.signal: aborts when the host's gateway.stop() runs
			},
			async stopIntake() {},
			async stop() {},
			health() {
				return "ok"; // or "degraded"
			},
		},
	};
}
```

Rules for engine authors:

- **Lifecycle.** The engine starts AFTER the server listens (a failed
  `start` latches `health.gateway: "degraded"` until restart — boot
  never wedges). Shutdown is ordered: SSE streams end, the HTTP drain
  completes, then `stopIntake()` closes inbound chat intake BEFORE the
  event bus drains pending settles (the drain is the last admission
  window), then `stop()` halts the adapters only after every settle has
  been delivered, then the refresh scheduler stops and the harness
  closes.
- **Health comes from `gateway.health()`, never the `health` field.**
  A result carrying both quarantines (`a gateway engine reports health
  through gateway.health(), not the health field`) — the `health`
  field is the provider-contributor surface and would double-report.
  A throwing `health()` reads `"degraded"` in `/v1/meta` (logged once
  per process; the route stays 200).
- **Adapters without an engine are inert.** A deploy with channel
  adapters and no engine logs one boot warning
  (`channels contributed but no gateway engine is loaded`) and marks
  each contributing row `inert: "no gateway"` in `GET /v1/extensions`;
  `/v1/meta` omits `health.gateway` entirely.
- A malformed declaration (a missing `start`/`stopIntake`/`stop`/
  `health` function) quarantines the extension at load.

## Building surfaces

A **surface** is a block tree with a data model behind it, rendered by
both channels (webui and TUI) from one definition. You build trees with
the typed builders from `@sigrun/sigrun/blocks` — the host-linked copy
(the `tree()` wrapper stamps the server's block-set version, so never
bundle your own builders):

```ts
import { page, collection, card, bind, tree } from "@sigrun/sigrun/blocks";
import type { Tree } from "@sigrun/sigrun/blocks";
```

Builders return plain JSON; there is no runtime besides them. Any prop
whose value can change at runtime takes a literal or a **binding** —
`bind("/cards")` is a JSON Pointer into the surface's data model, and
inside a collection's card template `bind("./title")` resolves against
the current item. Structural props (`type`, `id`, `display`, `groupBy`,
field `name`s, handler names, ...) are literals, never bindings.

### Placements

Where a tree may appear decides which blocks, collection displays and
form fields it may use (spec §5.7; `validateTree` enforces the table):

| | view | panel | settings | chat | interaction | ambient |
|---|---|---|---|---|---|---|
| root block | `page` (required) | `page` (required, no `sidebar`) | `form` (required) | any (no `page`) | `form` (required) | any (no `page`, no `form`) |
| layout | all | all | `section` only | all | `stack`, `section` | `stack`, `columns` |
| content (`markdown`, `fields`, `callout`, `diff`, `details`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `stat`, `meter`, `log` | ✓ | ✓ | — | ✓ | — | ✓ |
| `chart`, `image`, `tree` | ✓ | ✓ | — | ✓ | — | — |
| `collection` | all displays | all displays | `list`, `table` | all displays | `list` | `list` |
| `form` | ✓ | ✓ | root only | ✓ | root only | — |
| fields in a form | all | all | all but `file` | all but `secret` | `text`, `longtext`, `number`, `toggle`, `choice`, `secret` | — |

**Ambient is literal-content only** (the 2026-10-24 ruling): the
ambient envelope carries no data document, so every value in the tree
is a literal — a binding is allowed only inside a collection's item
template (`bind("./label")` against a literal `items` array).

### The block catalog

One builder per block. Every example below is a complete tree.

**Content** — prose, key/value rows, status numbers, progress and logs:

```ts check
import { bind, markdown, stat, tree } from "@sigrun/sigrun/blocks";
import type { Tree } from "@sigrun/sigrun/blocks";

export function statusNote(): Tree {
	return tree(
		markdown({ text: "Deploy **finished**; see the status line." }),
	);
}

export function uptime(): Tree {
	return tree(
		stat({
			label: "Uptime",
			value: bind("/uptime"),
			format: "duration",
			tone: bind("/uptimeTone"),
		}),
	);
}
```

**Chart** — time series with thresholds:

```ts check
import { bind, chart, tree } from "@sigrun/sigrun/blocks";
import type { Tree } from "@sigrun/sigrun/blocks";

export function cpuChart(): Tree {
	return tree(
		chart({
			title: "CPU",
			x: { kind: "time", format: "time" },
			y: { format: "percent", min: 0, max: 1 },
			series: [{ name: "cpu", kind: "area", data: bind("/cpu") }],
			thresholds: [{ at: 0.8, tone: "warn" }, { at: 0.95, tone: "bad" }],
		}),
	);
}
```

**Collection** — one item block with five displays (`list`, `table`,
`lanes`, `grid`, `calendar`). `items` binds an array of objects each
with a unique `id`; `card` is the item template, its `bind("./…")`
pointers resolving against the current item:

```ts check
import { bind, card, collection, tree } from "@sigrun/sigrun/blocks";
import type { Tree } from "@sigrun/sigrun/blocks";

export function recentJobs(): Tree {
	return tree(
		collection({
			id: "jobs",
			items: bind("/jobs"),
			display: "list",
			item: card({
				title: bind("./name"),
				subtitle: bind("./lastRun"),
				status: { label: bind("./state"), tone: bind("./tone") },
			}),
		}),
	);
}

export function jobsTable(): Tree {
	return tree(
		collection({
			id: "jobs",
			items: bind("/jobs"),
			display: "table",
			columns: [
				{ field: "name", label: "Name", sortable: true },
				{ field: "duration", label: "Duration", format: "duration" },
				{ field: "state", label: "State", cell: "badge" },
			],
			item: card({ title: bind("./name") }),
		}),
	);
}
```

**Form and fields** — a `form` binds an object path; each field's
`name` is its path inside it. All eleven field builders share the same
base props (`name`, `label`, `help`, `required`, validation,
`apply`):

```ts check
import { choice, form, number, text, toggle, tree } from "@sigrun/sigrun/blocks";
import type { Tree } from "@sigrun/sigrun/blocks";

export function filterForm(): Tree {
	return tree(
		form({
			id: "filter",
			bind: "/view/filter",
			mode: "live",
			children: [
				text({ name: "query", label: "Search", kind: "search" }),
				choice({
					name: "state",
					label: "State",
					options: [
						{ id: "open", label: "Open" },
						{ id: "done", label: "Done" },
					],
				}),
				number({ name: "limit", label: "Max items", min: 1, max: 500 }),
				toggle({ name: "archived", label: "Include archived" }),
			],
		}),
	);
}
```

The rest of the field set: `longtext` (with `syntax`/`lang`), `date`,
`datetime`, `daterange` (with presets), `secret` (write-only — the
channel shows `set (stored)` / `set (env)` / `not set` from a bound
status), `file` (uploads through the surface's upload route; see
"Uploads and assets"), and `list` (a repeatable group of fields).

**Stat, meter, log** — the dashboard and ambient trio:

```ts check
import { log, meter, stat, tree } from "@sigrun/sigrun/blocks";
import type { Tree } from "@sigrun/sigrun/blocks";

export function gauges(): Tree {
	return tree(
		stat({ label: "Requests", value: 12840, format: "compact", sparkline: [3, 5, 4, 8, 7] }),
	);
}

export function disk(): Tree {
	return tree(
		meter({
			label: "Disk",
			value: 0.62,
			format: "percent",
			thresholds: [{ at: 0.8, tone: "warn" }, { at: 0.95, tone: "bad" }],
		}),
	);
}

export function recentOutput(): Tree {
	return tree(
		log({
			lines: [{ level: "info", text: "backup completed" }],
			follow: true,
		}),
	);
}
```

**Callout, diff, details** — attention, review, and collapsed JSON:

```ts check
import { callout, details, diff, tree } from "@sigrun/sigrun/blocks";
import type { JsonValue, Tree } from "@sigrun/sigrun/blocks";

export function restartNotice(pending: readonly string[]): Tree {
	return tree(
		callout({
			tone: "warn",
			title: "Restart required",
			body: `Pending: ${pending.join(", ")}`,
			actions: [
				{
					id: "restart",
					label: "Restart",
					action: { type: "restart", confirm: { title: "Restart sigrun?" } },
				},
			],
		}),
	);
}

export function proposedEdit(): Tree {
	return tree(
		diff({ path: "src/index.ts", lang: "ts", before: "const a = 1;", after: "const a = 2;" }),
	);
}

export function rawPayload(payload: JsonValue): Tree {
	return tree(details({ value: payload }));
}
```

(The `details` value is `JsonValue` — opaque JSON the channel shows
collapsed and pretty-printed.)

Also available: the layout blocks `stack`, `columns`, `grid`,
`section`; `image` (see "Images"); `fields` (key/value rows); and
`treeBlock` (a lazy `tree` block — the `tree` name belongs to the root
wrapper).

### Actions and the turn rule

Actions live where a block offers buttons (`page.actions`, card
`actions`, `callout.actions`, `onActivate`) or as a block's named
gesture handler (`onMove`, `onCheck`, `onSubmit`, `onUpload`, ...).
There are three kinds (spec §6.2):

- **view-only** — sort, filter, expand, `navigate(params)`, a live form
  bound under `/view/…`. The channel applies it locally; nothing
  reaches the server, and it never starts a turn.
- **edit** — `move`, `edit` (checkbox toggles, inline field edits), a
  `submit` with `turn: false`. The placement's handler runs and the
  change is saved, silently. The agent hears about it in the next
  change note, not immediately.
- **answer** — a `submit` (default `turn: true`), or any action with
  `turn: true`. The handler runs, then a turn starts: the user sees the
  result NOW.

The rule of thumb: **`turn: true` only when the user must see the
result immediately.** A lanes board's drag is a `move` — saving each
drag as it happens is right, but interrupting the agent with a turn per
drag is not. Set `turn: true` on a `move` or `edit` only when each one
needs an immediate reply. `turn` is valid only in the `chat` placement;
validation rejects it anywhere else.

### Access and sharedData

Every render and every action carries the **principal** (who is
looking). Your `render` returns `access: "none" | "read" | "write"`
for that principal (spec §6.5):

- `none` — the surface is `404 surface_not_found` on every route
  (indistinguishable from one that doesn't exist), no events, no rail
  entry.
- `read` — the channel hides every edit and answer action and disables
  reorder, checkable, inputs and bulk actions. You never build a second
  tree for read-only users.
- `write` — everything.

The server enforces the verdict per principal (a 60-second cache keyed
by `(slug, id, key, principal.user)`); your handlers still check access
themselves — the server's check is defence in depth, not your only
guard.

**`sharedData: true`** declares that every principal with access sees
the SAME data (a shared board). It changes what the server keeps
(spec §7.3): ops passed to `changed` and accepted actions are retained
(last 100 per instance), so a `since` fetch inside the window returns
just the ops. Without it (the default — data is principal-specific),
the server keeps nothing: ops passed to `changed` are ignored and every
data fetch re-runs your `data()` as the fetching principal. Never mark
a surface `sharedData` if its data differs per user.

### Freshness: `changed` and the rev

A surface's data has a monotonic **`rev`, assigned by the server** —
you hand the server `DataOps`, never a rev. Three ways a channel learns
data moved (spec §7.3):

1. **`host.surfaces.changed(id, key, update?)`** — publish that instance
   `key` (the string `instanceKey(params)` returns) changed. Watchers
   (streams whose last fetch's access wasn't `none`) get a
   `surface.changed` event carrying `{slug, id, k, rev, treeRev}` —
   params never appear in events and the event carries no data — then
   fetch `…/data?since=<rev>` as their own principal.
2. **Since-windows** — on a `sharedData` surface the server keeps the
   last 100 ops per instance; a `since` fetch within the window returns
   `{rev, treeRev, ops}`, older fetches re-run `data()`.
3. **`refreshMs`** — channels refetch data on that interval while the
   surface is visible (min 5000), with no event at all. Dashboards use
   this.

Declare `data()` whenever you set `refreshMs` or call `changed` —
without it a refetch would re-run the whole `render`. A gap in `rev`
means the channel fetches the full data again.

### Uploads and assets

A `file` field uploads through the surface's own upload route
(`PUT /v1/ext/<slug>/surfaces/<id>/uploads/<field>/<name>`): the raw
bytes go to your `onUpload` handler and NOWHERE else — core keeps no
copy. The payload is `{field, name, mime, bytes}` with the filename
sanitised to a basename, the mime sniffed from the bytes (never the
client's claim), and `bytes` capped by the field's `maxBytes` and
`server.maxUploadBytes`. Store what you want in your own stores.

Static files ship in your package's `assets` directory (declared as
`sigrun.assets` in the package manifest) and are served at
`/v1/ext/<slug>/assets/<path>` — public to every signed-in user, like
any static file of an installed package, so never put private data in
`assets`. Paths are resolved with `realpath` and must stay inside the
assets directory; `..` segments and symlinks out of it are 404.

### Images

An `image` block's `src` takes three forms (spec §11.1):

- **`asset:<path>`** — a file from your assets directory (above).
  Untouched by the proxy.
- **`data:image/png|jpeg|gif|webp;base64,…`** — at most 192 KiB of
  base64 text, counted toward whichever of the tree or the data holds
  it (§4.5). Untouched by the proxy.
- **`https://…`** — the server REWRITES it to a signed `/v1/image`
  proxy URL before the tree or data leaves the server (24-hour
  signature; the proxy re-resolves and vetoes private/refused address
  ranges, caps the fetch at 10 s / 10 MiB, and sniffs the body as PNG,
  JPEG, GIF or WebP).

SVG and AVIF are never accepted (script payload; no TUI decoder), and
`http:` URLs are rejected. The CSP consequence: the webui sends
`Content-Security-Policy: img-src 'self' data:` — a missed rewrite or a
markdown image from another origin simply doesn't load. A failure
renders the block's `alt` text (which is required).

The `src` forms side by side (each `alt` is required — it is the
fallback when the image cannot load):

```ts check
import { image, stack, tree } from "@sigrun/sigrun/blocks";
import type { Tree } from "@sigrun/sigrun/blocks";

export function imageForms(): Tree {
	return tree(
		stack({
			children: [
				// A file from the extension's own assets directory.
				image({ src: "asset:acme/diagram.png", alt: "Pipeline diagram" }),
				// An inline data URL (PNG/JPEG/GIF/WebP, at most 192 KiB).
				image({
					src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
					alt: "One-pixel swatch",
				}),
				// A remote URL — rewritten to the signed /v1/image proxy.
				image({
					src: "https://images.example.invalid/chart.png",
					alt: "Rendered chart from the images host",
				}),
			],
		}),
	);
}
```

### Settings sections with apply

A settings section is a static `settings`-placement tree — a root
`form` bound to your settings object (`settings/<slug>.json`) —
declared in the factory result's `surfaces.settings` (spec §13.3).
Every field declares **`apply: "live" | "restart"`**:

- `live` (the default for extension fields): the value is read where
  it's used; saving takes effect with no restart.
- `restart`: the value is read at boot. For CORE sections, saving
  stores it and marks it pending — `GET /v1/settings` returns
  `pendingRestart: string[]`, and the core settings surface shows a
  `callout(tone: "warn")` listing them with a Restart button for
  admins (when the server is supervised). For EXTENSION sections the
  marker is not wired yet: the loader accepts `apply: "restart"`, the
  value is stored and read at the next boot, but no pending marker or
  warn callout is produced today.

Mark a field `restart` when your factory reads the value at load;
everything else stays `live`.

### Worked example: a lanes board

A kanban board view: cards grouped into lanes, drag within and across,
a live filter in the sidebar, and a detail pane (the H2/S1 shape from
the sizing pass):

```ts check
import { bind, card, choice, collection, form, markdown, page, text, toggle, tree } from "@sigrun/sigrun/blocks";
import type { JsonObject, Tone, Tree } from "@sigrun/sigrun/blocks";

export interface BoardCard {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	readonly assignee: string;
	readonly assigneeName: string;
	readonly age: string;
	readonly staleness: Tone;
}

export function boardTree(): Tree {
	return tree(
		page({
			title: "Board",
			switcher: choice({
				name: "board",
				label: "Board",
				options: bind("/boards"),
			}),
			sidebar: [
				form({
					id: "filter",
					bind: "/view/filter",
					mode: "live",
					children: [
						text({ name: "q", label: "Search", kind: "search" }),
						choice({ name: "assignee", label: "Assignee", options: bind("/people") }),
						toggle({ name: "mine", label: "Only mine" }),
					],
				}),
			],
			main: [
				collection({
					id: "cards",
					items: bind("/cards"),
					display: "lanes",
					groupBy: "status",
					groups: [
						{ id: "todo", title: "To do" },
						{ id: "doing", title: "Doing" },
						{ id: "done", title: "Done" },
					],
					reorder: { within: true, across: true },
					onMove: "move",
					item: card({
						eyebrow: bind("./id"),
						title: bind("./title"),
						meta: [
							{ person: { user: bind("./assignee"), name: bind("./assigneeName") } },
							{ time: bind("./age"), format: "relative" },
						],
						tone: bind("./staleness"),
					}),
				}),
			],
			detail: [markdown({ text: bind("/detail") })],
			empty: { icon: "board", title: "No cards", hint: "Create one to get started." },
		}),
	);
}

export function boardData(cards: readonly BoardCard[]): JsonObject {
	return {
		boards: [
			{ id: "ops", label: "Ops" },
			{ id: "home", label: "Home" },
		],
		people: [
			{ id: "ada", label: "Ada" },
			{ id: "grace", label: "Grace" },
		],
		// The wire data is plain JSON; a typed record list widens to it.
		cards: cards.map((c) => ({ ...c })),
		detail: "Select a card.",
		view: { filter: { q: "", assignee: "", mine: false } },
	};
}
```

The `move` handler receives `{itemId, from, to}` and answers
`{ok: true}` — the server increments `rev` and announces it; the
channel's optimistic overlay holds the card where the user dropped it
until your data catches up (spec §6.3). A read-only principal gets the
same tree with `reorder` disabled by the channel.

### Worked example: a settings section

A section for an extension with one live field, one restart field, and
a write-only secret (the S2 shape):

```ts check
import { choice, form, secret, section, text, tree } from "@sigrun/sigrun/blocks";
import type { Tree } from "@sigrun/sigrun/blocks";

export function settingsForm(): Tree {
	return tree(
		form({
			id: "acme-settings",
			// The section's surface data is {settings, secrets}; fields
			// resolve under the settings object.
			bind: "/settings",
			mode: "submit",
			submitLabel: "Save",
			children: [
				section({
					title: "Sync",
					children: [
						choice({
							name: "interval",
							label: "Sync interval",
							help: "Read where it is used — saving applies immediately.",
							apply: "live",
							options: [
								{ id: "5m", label: "Every 5 minutes" },
								{ id: "1h", label: "Hourly", recommended: true },
							],
						}),
						text({
							name: "endpoint",
							label: "Endpoint URL",
							kind: "url",
							placeholder: "https://sync.example.invalid",
							help: "Read at boot — a saved change applies at the next restart.",
							apply: "restart",
							required: true,
						}),
					],
				}),
				section({
					title: "Credentials",
					children: [
						secret({
							name: "apiKey",
							label: "API key",
							help: "Write-only; the field shows set (stored) / set (env) / not set.",
						}),
					],
				}),
			],
		}),
	);
}
```

Saving validates every field, writes the settings object, then fires
`settings.changed` (your `onSettingsChanged(keys)` runs after the write
commits). The core `pendingRestart` marker described above does not
cover extension fields yet — a saved `restart` value applies at the
next boot.

### Worked example: a dashboard

A metrics dashboard view: stats with sparklines, thresholded charts,
and a refresh interval — data-only updates on the tick, layout sent
once (the S7 shape):

```ts check
import { bind, chart, grid, meter, page, stat, tree } from "@sigrun/sigrun/blocks";
import type { Tree } from "@sigrun/sigrun/blocks";

export function dashboardTree(): Tree {
	return tree(
		page({
			title: bind("/name"),
			main: [
				grid({
					minItemWidth: "m",
					children: [
						{
							block: stat({
								label: "Up",
								value: bind("/up"),
								format: "percent",
								tone: bind("/upTone"),
								sparkline: bind("/upSeries"),
							}),
						},
						{
							span: 2,
							block: chart({
								title: "CPU",
								x: { kind: "time", format: "time" },
								y: { format: "percent", min: 0, max: 1 },
								series: [{ name: "cpu", kind: "area", data: bind("/cpu") }],
								thresholds: [
									{ at: 0.8, tone: "warn" },
									{ at: 0.95, tone: "bad" },
								],
							}),
						},
						{
							block: meter({
								label: "Disk",
								value: bind("/disk"),
								format: "percent",
								thresholds: [{ at: 0.9, tone: "bad" }],
							}),
						},
					],
				}),
			],
		}),
	);
}
```

Declare it with `refreshMs: 15000` and a `data()` handler: channels
refetch data every 15 s while the dashboard is visible, as their own
principal, with no event — and a refetch re-runs `data()`, never
`render`, so the layout is sent once.

## Execution isolation and the per-user surface

**When isolation is on**, a user's agent can reach only their workspace,
their grants, their home and temp directories, and read-only system paths.
It cannot read sigrun's files or environment, other users' files, or signal
processes outside its jail.

**Not covered:** extensions run inside sigrun with full access, like any
installed package — install only extensions you trust. One user's agent can
still exhaust CPU, memory, or disk. Outbound network is not restricted.
macOS and Windows hosts run single-user only.

**Shared MCP servers** hand every permitted user's agent the admin's
credential for that service.

**File modes are not the boundary.** Workers that share sigrun's uid are
confined by Landlock alone; `0700` directories are hygiene.

**Single-user servers** run the agent with full host access.

**Every peer in `trustedProxies` can forge any identity**; with isolation
on, the shared secret is required for that reason.

System-level extensions need none of the per-user APIs below: they run as
trusted code inside sigrun and use the system stores documented above.

For kernel-suite provenance, `/proc` and ptrace denials are compared with
the same operation outside a jail. When the outside operation also fails
(for example under Yama), CI labels the case Yama/host-policy satisfied and
not Landlock-discriminating. Successful `osUser` switching and the uid-switch
discrimination need a privileged runner with `CAP_SETFCAP` and
`SIGRUN_SANDBOX_IT_PRIVILEGED=1`; otherwise they skip with a named reason.

The per-user APIs below are additive. They do not replace the shared stores
or make an extension's in-process code untrusted.

### Per-user stores

`host.stores.user(user)` returns the same five-store shape as the shared
handle, scoped to one directory user **and still scoped to your slug**:

| surface | location and behavior |
|---|---|
| `secrets` | Your section of `<configDir>/user-secrets/<user>.json`; atomic writes, mode `0600`, one top-level section per extension slug. |
| `settings` | Your `<configDir>/user-settings/<user>/<slug>.json` object; absent reads as `{}`. |
| `paths.data` | `<dataDir>/<slug>/users/<user>/` |
| `paths.state` | `<stateDir>/<slug>/users/<user>/` |
| `paths.cache` | `<cacheDir>/<slug>/users/<user>/` |

Each per-user raw path is created synchronously on first access, including
`data` and `state` (unlike the shared handle, whose data/state slug subdirs
are yours to create). The handle throws for an unknown user, and validity
is checked again on every operation rather than cached. The sole exception
is the deletion window described below: while that user's `userDeleted`
fan-out is active, their stores still resolve so you can revoke provider
credentials before core removes them.

Users can manage their own settings and secret keys through
`/v1/me/extensions/<slug>/settings` and
`/v1/me/extensions/<slug>/secrets/<key>`. Secret values are accepted on PUT
but never returned by these HTTP routes. `GET /v1/me/services` reports only
the calling user's services.

### Per-user tools

Declare `perUserTools: true` in the factory result, then publish or replace
one user's tools **after the factory has resolved**. The declaration is read
from the return value, so calling `setUserTools` in the factory body throws
`perUserTools not declared`. There is no dedicated after-factory publication
hook: publish from a post-load entry point such as a route, command, worker,
or lifecycle handler. This example publishes when a conversation is created
for its owner:

```ts
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

export default function createAcmeTools(host: SigrunHost): SigrunExtensionResult {
	return {
		extension: defineExtension({ name: "acme-tools" }),
		perUserTools: true,
		conversationCreated: ({ owner }) => {
			if (owner === undefined) return;
			host.tools.setUserTools(owner, [
				defineTool({
					name: "acme-profile",
					description: "Read the calling user's Acme profile",
					parameters: Type.Object({}),
					execute: async () => ({
						output: [{ type: "text", text: "Acme profile" }],
					}),
				}),
			]);
		},
	};
}
```

This mirrors the shipped fixture's declaration and its post-boot
publication through the captured host. Choose the post-load entry point
that fits your extension's provisioning flow; `conversationCreated` alone
does not backfill publications for users who create no new conversation.

Core installs the publication as `<slug>@<user>` (here,
`acme-tools@alice` for owner `alice`); an empty tool list removes that
entry. Calling `setUserTools` without declaring `perUserTools: true`
throws.

For ordinary object/absent extension selections, core adds the owner's
per-user entries when a conversation is created, forked, or transferred,
and removes the previous owner's entries on transfer. Exact array
selections stay exact: old-owner names are removed on transfer, but no new
entries are inferred. At boot, core reconciles missing owner entries only
for object/absent selections, never for exact arrays.

**Selection is convenience; the wrapper is enforcement.** Core wraps every
published per-user tool. On every execution the wrapper reads the
conversation's **committed** owner and rejects the call without running
your tool when that owner differs from the publication's user. This still
holds if a hand-written exact selection names another user's entry.
Selecting an entry never grants its tools.

### Per-user services

Declare long-lived per-user processes with `userServices`. Each declaration
has a `name`, an optional positive `idleMinutes` (default 10; zero,
negative, non-finite, and non-number values quarantine the extension), and
`start(user, ctx)`, which returns a `ServiceSpec` or
`undefined` when the service is unavailable for that user. Connect through
`host.services.connect(name, user, ctx)`:

```ts
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";

export default function createAcmeService(host: SigrunHost): SigrunExtensionResult {
	return {
		name: "acme-service",
		userServices: [
			{
				name: "acme-api",
				idleMinutes: 10,
				start: async (user) => {
					const token = await host.stores.user(user).secrets.get("api-token");
					if (token === undefined) return undefined;
					return {
						command: "node",
						args: ["/opt/acme/service.js"],
						env: { ACME_API_TOKEN: token },
					};
				},
			},
		],
	};
}
```

`ServiceSpec` supplies `command`, `args`, optional `env`, `cwd`, and
`readPaths`. Core owns the process. A successful connect returns a
`ServiceHandle` with `stdin`, `stdout`, `stderr`, `exited`, and `release()`;
release the handle when done so the idle policy can apply. Repeated
connections attach to the same process. After the last handle is released,
the service stops once it has had no traffic for `idleMinutes`.

With isolation inactive (a single-user server), services run as plain child
processes with the M0 allowlist environment and the same API.

Each service runs as its **own** jailed process under that user's policy.
Workers and services are sibling jail domains: the user's agent cannot read
the service's environment. Pass credentials through `ServiceSpec.env`, or
have the service read a file under the user's data path; **never put them in
the agent's workspace**. Service `env` is merged over the user's base
execution environment, and `SSH_AUTH_SOCK` is removed.

Three crashes within five minutes put the service in `failed`. Further
connects fail rather than restart-looping. A committed settings write for
**that extension and that same user** clears the failure fence (the
self-service settings PUT performs it); a sigrun restart also clears the
process-local crash history. Core stops a user's services on user deletion,
stops an extension's services when it is quarantined, and stops all services
during shutdown.

The kernel boundary suite has not run yet; CI is its first execution. Do
not treat service/worker isolation as kernel-verified from unit tests.

### Per-user settings sections

A `SettingsSectionDef` can set `scope: "user"`. The section then reads and
writes the calling user's per-user settings instead of the shared
`settings/<slug>.json`. It is visible to every signed-in user unless
`admin: true` is explicit; a principal with no directory user gets `400`.
Omit `scope`, or use `"server"`, for deployment-wide shared configuration.

```ts
const section = {
	id: "acme-personal",
	title: "Acme (personal)",
	scope: "user" as const,
	admin: false,
	form: {
		v: 1,
		root: {
			type: "form",
			id: "acme-personal-form",
			bind: "/settings",
			mode: "submit",
			onSubmit: "save",
			children: [{ type: "text", name: "nickname", label: "Nickname" }],
		},
	},
};
```

### What `userDeleted` guarantees

An administrator deletes with `DELETE /v1/users/<user>?transferTo=<recipient>`.
Core transfers owned resources, revokes the departing user's tokens and
account links, stops their worker and services, and removes their per-user
tool entries **before** emitting your `userDeleted({ user, transferTo })`
handler.

During that handler, the departing user's directory record and per-user
secrets are still readable. Use this window to revoke credentials at the
external provider or clean up extension-owned remote state. After the
fan-out, core removes the directory record, then deletes:

- `<configDir>/user-secrets/<user>.json`;
- `<configDir>/user-settings/<user>/`; and
- `<cacheDir>/<slug>/users/<user>/` for each cache slug.

Credentials belong to the departing person: they are never transferred to
the recipient. Per-user **data and state are your extension's decision** —
core deliberately leaves them in place. Move, retain, or delete those in
`userDeleted` according to your own ownership and retention rules.

## Uninstall

There is no automatic deletion, anywhere. Removing an entry from
`extensions[]` stops the extension from loading; its retained settings
file and secrets section are **inert** — nothing reads them — and
sigrun deliberately refuses to destroy credentials on a typo'd edit.
`{ "enabled": false }` never deletes anything either. Data, state, and
cache directories stay in place for the same reason: the operator may
still want them. Forced removal belongs to future extension-management
commands; none ship today.

## Backup

Backup is **optional and off by default**, opted in per section:
`SIGRUN_BACKUP_SECTIONS` takes a comma list of `config`, `secrets`,
`data`, `state` — cache is never a valid section. Each enabled section
tars its store root alongside the harness DB backup; the `config` and
`secrets` tarballs carry `auth.json`/`secrets.json` and are written
mode `0600`. An extension that follows the buckets gets backup-safe
persistence by deployment choice alone — no extension code involved.
