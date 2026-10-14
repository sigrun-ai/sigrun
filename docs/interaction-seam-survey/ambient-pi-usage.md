# pi-usage — Ambient-Surfaces Inspection

## 1. SURFACES
Exactly **one** ambient surface: a single keyed **statusline entry** (`src/usage.ts:127` — `ctx.ui.setStatus(STATUS_KEY, value)` with `STATUS_KEY = "usage"`, `usage.ts:58`; `src/statusline-display.ts` enforces "one line": control chars/breaks rejected, `CONTROLS` regex + `safeStatuslineText`). No widget, footer panel, overlay banner, or above-editor surface. Placement: pi statusline slot, budget = 1 terminal line (plain string, no width rule beyond line-ness).

Update triggers/cadence (`usage.ts:1431-1459`):
- `session_start`, `session_tree`, `model_select`, `turn_start` → refresh; plus a **TTL refresh timer at `CACHE_TTL_MS = 5*60_000`** (`usage.ts:51,146-153`) and a **countdown repaint timer at `STATUS_COUNTDOWN_REFRESH_MS = 60_000`** when any `resetsAt` window is shown (`usage.ts:205-219`).
- Errors render as one-line chips: `auth unavailable` / `selection required` / `usage err: <msg truncated 50>` (`usage.ts:165-172`). Adapters can opt out via `publishesStatusline === false` (`types.ts:156`).

Persistence medium: **none on disk**. The statusline value is in-memory only. Reports cache in `UsageCache` (in-memory `Map`, TTL 5 min, max 32 entries, keyed provider+fingerprint — `src/core.ts:4-58`), cleared at `session_shutdown` (`usage.ts:1458-1473`). Does NOT survive reload/restart; status cleared on shutdown (`safeSetStatus(ctx, undefined)`). Settings (`pi-usage.json`) persist, but that's config, not ambient state.

## 2. DATA MODEL
Backing the surface ultimately:

```ts
// types.ts
interface UsageBucket { id: string; label: string; groupId?; groupLabel?;
  modelKeys?: string[]; used?; remaining?; limit?; unit: "percent"|"usd"|"currency"|"count";
  period?: string; windowMinutes?: number; resetsAt?: number; }
interface UsageMetric { id; label; value: number|string; unit?; currency?; }
interface UsageReport { providerId; providerName; capturedAt; source; semantics; accountLabel?;
  buckets: UsageBucket[]; metrics: UsageMetric[]; notes?: string[]; }
```

But the statusline slot itself receives only a rendered **string**, shaped by a user template:

```ts
// statusline-display.ts
interface StatuslineDisplay { template: string /* "{provider} {windows}" */;
  window: string /* "{window}:{value}" */; countdown: string /* "{value} ↻ {reset}" */;
  separator: string /* " · " */; }
```

## 3. INTERACTIVITY
**None on the surface.** The statusline is a read-only string; no keys, click, collapse, navigation. Human editing of ambient state happens only indirectly: the `/usage` command opens a transient menu (`ctx.ui.select`, `usage.ts:831`; settings editor via `ctx.ui.custom` in `usage-settings-ui.ts:33`) which can change settings (percentage remaining/used, codex countdown toggle) that re-render the line; `/reload` applies hand-edited `statuslineDisplay` templates (README §Quota statusline display; no interactive template editor). Footer-classic read-only — confirmed.

## 4. MAPPING
- Statusline "usage" slot → **A `line` = FULLY** (keyed status slot, one line, state replacement via `setStatus(key, string|undefined)`; chips incl. error text fit `line`).
- The underlying `UsageBucket` data (used/remaining/limit/resetsAt per window) would map richly to **B `rows`** (labels+metrics+completed-style statuses) / **C `gauge`** (percent + phase/reset elapsed), but the extension deliberately formats into one line, so A covers the rendered surface; B/C are only partial for the *data*, not needed for the surface.
- **D `ledger`**: NOT AT ALL — no feed anywhere.
- Nothing needs an opaque `details` fallback: output is one sanitized line; even the error chips are plain text.

## 5. VERDICT
**~100%** of ambient content covered by `{A/B/C/D}` — in practice **100% by A alone** (`line`); B/C would be richer alternatives for multi-window quota data but the surface is fully expressible as a line. Missing primitive: none material. Most useful envelope rule learned: the countdown timer means a `line` slot needs **scheduled re-render** (timer-driven updates between data refreshes) — an `expires`/`refreshMs` hint on the ENVELOPE would capture this; also `metrics? {current?}` inside a row would carry reset countdowns if A were extended toward B. **The human never acts on the surface itself** — all interaction is via the `/usage` dialog; the statusline is pure read-only display.

Sources: `src/usage.ts` (51-58, 90-219, 1431-1479), `src/statusline-display.ts`, `src/types.ts` (18-45, 150-160), `src/core.ts` (4-58), `src/format.ts`, `README.md`, `src/usage-settings-ui.ts:20-80`.
