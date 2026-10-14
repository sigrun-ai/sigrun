# pi-powerline-footer — ambient-surface inspection

## 1. SURFACES

All ambient surfaces are TUI widgets/lines registered via pi's `ctx.ui.setWidget`/`setFooter`/`setStatus`/`setHeader` (`index.ts`). Render is closure-based: each widget factory returns `{render(width): string[]}` from in-memory extension state; updates fire on pi events (agent_start/message_update/message_end/turn_end/session_before_compact/session_compact) which call `requestStatusRender()` via a trailing scheduler (`render-scheduler.ts`) that defers during typing (~EDITOR_STATUS_DEFER_MS) — context streaming refreshes throttled (CONTEXT_STATUS_RENDER_MS), git has 1s cache TTL async fetch (`git-status.ts`), vibes refresh capped at 30s. No file-persistence for any widget state except: queue items (`queue/store.ts` → `powerline-footer/inbox.jsonl` + `projects.json`), stash history (`powerline-footer/stash-history.json`), preset selection (agent settings.json, `parsePowerlineConfig`). Everything else in-memory; survives `/reload` only via deliberate handoff (active stash symbol-keyed `transferActiveStashReload`, `type.ts:ACTIVE_STASH_RELOAD_STATE_KEY` + Symbol.for) and files above; lost on quit (except the three file-backed surfaces). No expiry/TTL; widgets vanish by rendering `[]` when their state is empty.

- **primary powerline row** — `powerline-top`, placement aboveEditor (or belowEditor per config.placement). One segmented line of ~20 built-in segments (`segments.ts`, ids in `types.ts:BUILTIN_STATUS_LINE_SEGMENT_IDS`): model, thinking, shell_mode, path, git, subagents, queue, token_in/out/total, cost, cache_read/write, context_pct/total, time_spent, time, session, hostname, extension_statuses. Responsive `getResponsiveLayout(width)` overflows into a secondary line; `secondaryOverflow: drop|wrap` (README).
- **footer/secondary row** — `ctx.ui.setFooter` (`index.ts:3524`) renders `powerline-secondary` lines (secondarySegments + overflow), plus `extension_statuses` notification lines above editor (`powerline-status` widget, `renderPowerlineStatusLines`, statuses starting `[`).
- **bash transcript** — `powerline-bash-transcript`, belowEditor, last 4 commands with status glyph + 6-line output tail, capped 16 lines (`bash-mode/types.ts:BashCommandRecord/Snapshot`); truncation counter as first line.
- **queue preview** — `powerline-queue-preview`, belowEditor, single line for the leading queued/blocked/delivering item (`QueueSummary.leadingText/leadingStatus`, text prefixed `blocked:`/`sending:`/`queued:`).
- **pending-send countdown** — `powerline-pending-send`, belowEditor, single line (`sending in Ns · esc to edit · enter to send now` + preview); only during the delayed-send window.
- **last prompt** — `powerline-last-prompt`, belowEditor, truncated last user prompt, cached (`lastPromptRenderCache`).
- **stash status** — `ctx.ui.setStatus("stash", …)` keyed slot, consumed by `extension_statuses`/"custom:" items.
- **welcome overlay/header** — banner splash as centered overlay (`setupWelcomeOverlay`, `WelcomeComponent` in `welcome.ts`) or header variant (`setHeader(WelcomeHeader)`, quietStartup) with model, recent sessions, loaded counts, AGENTS.md files, token estimate; auto-dismiss 30s or any key.
- **editor frame** — custom editor component re-renders border/first-blank-line (ambient chrome, not a widget).

## 2. DATA MODEL

```ts
// types.ts
interface RenderedSegment { content: string; visible: boolean }
interface StatusLineSegment { id; render(ctx: SegmentContext): RenderedSegment }
interface SegmentContext { model; thinkingLevel; usageStats: UsageStats; contextTokens/Percent/Window; queueSummary: QueueSummary;
  git: GitStatus; extensionStatuses: ReadonlyMap<string,string>; options: StatusLineSegmentOptions; colors; theme; … }
interface UsageStats { input,output,cacheRead,cacheWrite,cost,subagentCost: number }
interface GitStatus { branch: string|null; staged; unstaged; untracked: number }
interface QueueSummary { queueCount; blockedCount; compacting: boolean; leadingText: string|null; leadingIntent: "steer"|"follow-up"|"post-compact"|null; leadingStatus: "queued"|"blocked"|"delivering"|"sent"|"failed"|null }
// queue/types.ts
interface PowerlineQueueItem { id,text: string; createdAt,updatedAt: number; source; target: QueueTarget; intent: QueueIntent; status: QueueStatus; error? }
// bash-mode/types.ts
interface BashCommandRecord { id; command; startedAt; cwdAtStart; output: string[]; outputBytes; exitCode; finishedAt; truncated }
interface BashTranscriptSnapshot { commands; totalLines; totalBytes; truncatedCommands }
// types.ts — promotion of foreign extension statuses
interface CustomStatusItem { id; statusKey; position: "left"|"right"|"secondary"; color?; selfColorize; prefix?; hideWhenMissing; excludeFromStatuses }
```

## 3. INTERACTIVITY
Ambient surfaces themselves are read-only render strings; no click/collapse/navigation on widgets. Human acts *through* siblings keyed to the same state: `/queue` overlay (send/retry/clear/target, `showSelectOverlay` uses `ctx.ui.custom` SelectList), Esc/Enter on pending-send countdown, Alt+S stash, `/powerline placement|preset`, `/bash-mode` toggle. Welcome overlay: any key dismisses.

## 4. MAPPING
- primary row segments → **A line** (fully: each segment is a keyed single-line text/icon/color slot; color+conditional visibility ride naturally).
- pending-send countdown, queue preview, last prompt → **A line** fully (with metrics {current}) — though "partial" for pending-send because of inherent transient-by-deadline nature the envelope's `expires` covers it.
- stash status, extension_statuses notifications → **A line** fully.
- bash transcript → **B rows** (id/label/status enum/deps? — mot: `severity` covers `exit N` color, `detail` = output tail lines, depth = tail indent). Aggregate count of earlier commands ("… N earlier commands truncated") maps to B's collapse semantics.
- queue inventory behind /queue → **B rows** fully (status enum matches almost exactly: queued/blocked/delivering/sent/failed).
- welcome overlay → **NOT covered** by A–D (multi-column branded layout, gradient logo, keyboard tips) → opaque `details` fallback.
- theming/icons/presets/separators → config, not payload; envelope fine.
Nothing needs **C gauge** beyond degenerate use (context_pct could be gauge.percent but line suffices); **D ledger** unused.

## 5. VERDICT
~95% of ambient content covered: rows/segments are all either (A) keyed line segments or (B) row-shaped status records (bash transcript, queue). Welcome overlay (~5%, static splash) falls to opaque details. Most valuable missing primitive: none — the stress test instead surfaces an envelope rule: a **line primitive needs composed sub-segments** ("segment stack with separators/responsive overflow to a secondary line", `StatusLineLayout.left/right/secondary`, `secondaryOverflow`), i.e. a *composition* rule over line slots rather than a new primitive; and row `metrics` needs a derived/format-string variant (smart token formatting `formatTokens`, FN currency conversions) or hosts keep duplicating formatters. Human acts on the surface indirectly only (commands/shortcuts targeting state the ambient surface mirrors).
