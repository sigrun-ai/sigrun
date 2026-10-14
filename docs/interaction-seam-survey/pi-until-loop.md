# pi extension interaction-shape inspection: until-plugins (`pi-until-loop`)

Repo: /tmp/pi-ext-inspect/until-plugins. Pi is one of many hosts; the pi surface (`.pi/extensions/until.ts`, 172 lines) is thin — the interaction weight lives in the shared MCP loop (hosted server `https://run.until.dev/mcp`, mcp.json) plus the deterministic Python hooks (Cursor/Claude/Antigravity; NOT on pi per docs/setup.md:227 "Pi support includes the Until skills, startup guidance and MCP tools. It does not include the deterministic enforcement hooks").

## 1. KINDS
- **Bootstrap notice** — trigger: session_start/context/compact re-injection (`.pi/extensions/until.ts:60-105`); human sees a large prose protocol block in chat; does nothing; non-blocking; transient context (re-injected, not persisted).
- **Loop-stage block notices (gate denials)** — trigger: Until MCP tools mid-loop (submit/update/get_plan) with stages setup_required, pending_upload_expired, review_not_required_pending, review_requirement_unrecognized, changes_requested, peer_review (amp/messages.ts `InFlightVariant`, amp/policy.ts:112-135). Human sees twin messages: `agentMessage` (long imperative prose to the agent, containing a literal `touch '<skipPath>'` command) + `userMessage` (short status line). Human action: plain chat text ("continue", waiver phrase) or running a terminal command; never buttons. Blocking (tool-rejection); stage state is persistent (`~/.until/state/session-<convo>.json`, hooks/until-track-state.py).
- **Reviewer picker** — trigger: review-required plan (skills/getting-a-review/SKILL.md:50-59); human sees a list of human reviewer names, acts by chat selection; blocking stop; no durable widget.
- **Plan-acknowledgement waiver record** — trigger: "Don't use the Until Loop for this." (SKILL.md:93-107); remote shape is a JSON file the agent writes: `{kind:"remote", host:"cursor_cloud", quoted, waived:["plan_review","plan_check"], agent_url}` (hooks/until-commit-gate:462-493) + a PR-stamp annotation. Persistent.
- **Plan-check difference list** — trigger: PR opened (docs/plan-checks.md:46-56); human sees a list of differences each with tag (Missing/Changed/Beyond/Scope), "summary and a stable slug"; human acts by chat choice (fix/fix-plan/acknowledge) or records acknowledgement (comment with slug+reason). Blocking until resolved; the record lives server-side.
- **Custom-loop event notifications** (docs/custom-loops.md, e.g. Slack progress post :148-155) — server-run Markdown loops; no shaping in this repo.

## 2. MAPPING ({text, options, fields, diff})
- Bootstrap notice / gate block notices / prose statuses: **text** covers FULLY — everything is authored prose strings. `GateDecision` is `{ allow:false; agentMessage:string; userMessage:string }` (amp/policy.ts:65-67).
- Reviewer picker: **options** PARTIALLY — it's a natural choice list, but no `options[]` type exists in this repo (the selection is described in skill prose, not typed); label only, no id/tone fields to cite.
- Plan-check difference list: **text PARTIALLY / options PARTIALLY** — the fix/revise/acknowledge triage is a 3-way choice; the difference payload (tag + slug + summary) would ride in text or `details`.
- Waiver record: **fields PARTIALLY** — `{kind, host, quoted, waived[], agent_url}` maps loosely to typed fields but waived[] is a fixed enum pair; **diff NOT AT ALL** (no before/after semantics anywhere).
- Setup link: a bare URL string (`setup_url`, amp/fixtures/submit_plan_setup_required.json:9) — text covers FULLY.

## 3. GAPS (fall to JSON fallback)
- **Command-execution motif**: the waiver `touch '<skipPath>'` command string the human must run in their own terminal (messages.ts:11-14; commit-gate:774). Not text-only — it's an actionable imperative; nothing in the primitive set expresses "run this" except opaque prose.
- **Waiver payload**: `waived: ["plan_review","plan_check"]` + `quoted` verbatim quote + `agent_url` matching `^https://cursor\.com/agents/bc-[A-Za-z0-9-]+$` (commit-gate:283,489) — certified-lexeme fields, not freeform form fields.
- **Difference record**: `{tag: Missing|Changed|Beyond|Scope, slug, summary}` + `authorised` ack attribution (plan-checks.md:52,78-82) — a categorized ledger row, not a diff (no before/after content).
- **Expiry/deadline metadata**: `pending_upload_expires_at`, 15-min default window (session_stage.py:7) — time-scoped permissions, no primitive.
- **Twin-message split** (agentMessage vs userMessage) — no primitive distinguishes agent-directed vs human-directed prose.

## 4. PERSISTENT STATE
- `~/.until/state/session-<convo>.json` — reducer state `SessionState {plan_id, stage, review_requirement, review_policy_reason, pending_upload_command, pending_upload_expires_at}` (amp/policy.ts:36-43); written by until-track-state after MCP traffic, read by until-commit-gate; machine state, not a rendered surface.
- `~/.until/state/skip-<convo>` skip token (human-created), `~/.until/waivers/<convo>.json`, `~/.until/hooks.log`, `~/.until/plans/`, `~/.until/scratch/`.
- **No widgets/meters/statusbars/banners exist** — no iteration/progress meter anywhere (grep for meter/progress/widget; only docs/custom-loops.md Slack example). "Progress" is prose notices per stage transition.

## 5. VERDICT
~**85-90%** covered: every human-facing surface except the waiver record and difference ledger is authored prose (text), reviewer choice is a plain list (options). Most valuable missing primitive: an **"action-required human command/command-block" primitive** — payload `{command: "touch '~/.until/state/skip-<convo>'", why: string, humanOnly: true}` (messages.ts:11-14, commit-gate:758-764, SKILL.md:100-101) — recurring across ≈4 of 6 gate variants, and semantically crucial: the design intent is that the agent may relay but never execute it, which plain text encodes weakly. Second candidate: a categorized `{tag, slug, summary}` ledger entry for plan differences.

((~590 words))
