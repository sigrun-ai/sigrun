# Contributing to sigrun

## Workflow

1. Use Node `>=22.19.0` (the package `engines` requirement).
2. From a clean clone: `npm install` (workspaces: root, `webui/`, `tui/`).
3. Make a focused change on a branch; add or update tests for behavior
   changes.
4. Run the gates below, then commit with a **signed commit**
   (`git commit -S`).
5. Release tags, npm publishes, and other public-facing actions are
   **maintainer-approved only** — never create or push a version tag.

## Gates

Run the gates that match what you touched:

- **Core (always):** `npm test` and `npm run typecheck`.
- **Web UI changes:** also the webui workspace's test, typecheck, and
  build (`npm --workspace @sigrun/webui run test`, `npm run
  typecheck:webui`, `npm run build:webui`).
- **TUI changes (`tui/`):** also `npm --workspace @sigrun/tui run test`
  and `npm --workspace @sigrun/tui run typecheck`.
- **End-to-end:** `npm run test:e2e`. Failure triage follows the committed
  policy in [`AGENTS.md`](AGENTS.md) — see its "E2E failure triage"
  section; reproduce solo and under the full-suite shape before
  classifying any failure as pre-existing.
- **Sandbox integration tests** (`SIGRUN_SANDBOX_IT=1 npx vitest run
  test/sandbox-it`): only in a suitable Linux environment (Landlock ABI
  6+); the privileged cases additionally need the runner described in
  [`sandbox/README.md`](sandbox/README.md).
- **Extension repositories** use their own scripts and, where required,
  the sibling-checkout CI layout; see each repo's own docs.

## Ground rules

- **Synthetic fixtures only.** Tests and examples use synthetic hosts
  (`.example`, `example.invalid`), synthetic credentials, and placeholder
  account names. Private deployment details — real hostnames, domains,
  key paths, tokens, session transcripts — do not belong in issues, tests,
  fixtures, or committed docs.
- **Generated artifacts** (built `dist/`, generated provider/config files)
  are updated only through their owning build or generation command,
  never hand-edited.
- **Vulnerabilities:** report privately per [`SECURITY.md`](SECURITY.md);
  do not open public issues for them.
