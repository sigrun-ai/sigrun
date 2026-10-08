# Task 20: webui workspace scaffold + build/channel-bundle serving

Task 1 of 7 in the M2 webui rebuild. Read the plan
docs/superpowers/plans/2026-10-08-sigrun-m2-webui.md (Task 20 section) and the
spec docs/superpowers/specs/2026-10-04-sigrun-core.md §4.1/§6 (channel bundles)
+ §5 (the server the webui consumes).

## WHAT TO BUILD

The M2 webui is a NEW `webui/` workspace package (Vite + TypeScript + React),
built to a static bundle the core serves as the `webui` channel bundle. This
task is the scaffold + the serving seam — no real UI yet.

1. **The `webui/` package** (Vite + TS + React):
   - `webui/package.json` (name `@sigrun/webui`, react + react-dom deps,
     devDeps vite + @vitejs/plugin-react + typescript), `webui/vite.config.ts`,
     `webui/index.html`, `webui/src/main.tsx`, `webui/src/App.tsx`,
     `webui/src/api.ts` (a typed §5 client — getMeta/conversations/models as a
     start).
   - Root `package.json` becomes a workspace root (`workspaces: [".", "webui"]`
     or `"webui"` — pick the npm-workspaces shape that keeps the root's own
     deps + scripts working; the root package.json is private).
   - The App renders "sigrun" + the meta badges (fetch `GET /v1/meta`) as a
     smoke surface — enough to prove the bundle serves and the client works.
2. **The serving seam** (`src/server/static.ts` + `src/server/index.ts`):
   - Serve the built bundle at `/` when present (channel bundle, §4.1/§6).
     `@fastify/static` is the standard — add it as a dependency and serve
     `webui/dist` (or the configured path) at the root.
   - `capabilities.channels` includes `"webui"` when the bundle is present,
     `[]` when absent (a deployment with no webui bundle serves the §5 API
     only — supported, not an error).
   - The bundle path comes from config: `SIGRUN_WEBUI_BUNDLE` env, default
     `webui/dist` (resolved from the repo/deploy root). src/config.ts gains the
     field.
3. **SPA fallback**: client-side routing later — serve index.html for unknown
   non-/v1 paths so a deep link works (the standard SPA-fallback). /v1/* and
   /healthz /readyz stay API.

## PROCESS (TDD)

- Failing tests first (test/server-static.test.ts): bundle present → GET /
  returns index.html + a static asset, capabilities.channels includes "webui";
  bundle absent → GET / is 404 (or a minimal "api only" response — decide and
  document), channels []; /v1/meta unaffected; SPA fallback serves index.html
  for /some/client/route but NOT for /v1/* or /healthz.
- webui/src/api.test.ts: the typed client against a stub fetch.
- The Vite build must succeed (`npm run build` in webui/); the server test
  builds the bundle first (or uses a tiny hand-written dist/ fixture — decide
  and document; a fixture is faster and hermetic).
- Report INCREMENTALLY to
  .superpowers/sdd/2026-10-08-sigrun-m2-webui/task-20-report.md. PASTE actual
  verification tails.
- VERIFY before done: `npx tsc --noEmit` clean (root AND webui) +
  `npx vitest run` (root) all pass + the webui builds + a manual smoke
  (`npm start` the server with the bundle present, curl / → index.html).
- Commit `feat: webui workspace scaffold + channel-bundle serving`.

## CONSTRAINTS

- React + Vite + TypeScript. No CSS framework (the mockup's hand-rolled CSS is
  the style direction); no state-management library (React state + the
  transport hook is enough — M2's design invariant is "thin client").
- The webui is a CHANNEL BUNDLE — deploy-time static assets, never a runtime
  extension, never quarantined (spec §4.1/§6).
- Root package.json stays the sigrun core package; webui/ is a workspace
  member. Do NOT break the root's existing test/typecheck scripts.
- Fail loud on bundle-path misconfiguration (a set-but-missing bundle path is
  a boot error or a logged warning + channels [] — decide, document).

## TIME BUDGET (hard — a prior dispatch timed out with zero code)

Do NOT re-read the whole codebase. Read ONLY: this brief, src/server/index.ts's
route-registration + createServer shape (the first ~100 lines + one route),
src/config.ts (the SigrunConfig shape + loadConfig), and package.json. The §5
wire types you need are in src/server/views.ts (ConversationViewWire,
ConversationList, ModelsResponse) — read that one file for the client shapes,
not the whole server. Start writing webui/package.json + vite.config.ts within
your first few tool calls. Write the report incrementally as you go (not at the
end). The server test uses a hand-written dist/ fixture (do NOT run the vite
build inside vitest).

## REPORT must state

The workspace shape chosen, the serving seam (static mount + channels +
SPA fallback), the bundle-path config, test count/result, the manual smoke
evidence, commit hash, what T21 needs.
