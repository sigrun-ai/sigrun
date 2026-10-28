# Security policy

## Supported versions

The latest published minor release receives security fixes. Older 0.x
versions may require an upgrade; there is no backport program for previous
minors.

## Reporting a vulnerability

Report vulnerabilities privately through **GitHub private vulnerability
reporting** on the [`sigrun-ai/sigrun` security advisories
page](https://github.com/sigrun-ai/sigrun/security/advisories). This
reporting path depends on the feature being enabled on the repository; if
it is unavailable, say so in a public issue *without* any vulnerability
details so a maintainer can arrange a private channel.

Do not file vulnerability reports as public issues, and never include real
tokens, credentials, or private deployment details in any report.

## Response expectations

Acknowledgement and assessment are best-effort; no response-time SLA is
promised. Coordinated disclosure is requested: please allow time for a fix
before publishing details.

## Threat model

- **Installed extensions and host configuration are trusted code.**
  Extensions run in-process with the server and hold full tool authority;
  npm lifecycle scripts of configured packages execute at install time.
  Install only extensions you trust.
- **The per-user command/service jail isolates users** where Landlock is
  available and active (Linux, Landlock ABI 6+). `GET /v1/meta` exposes the
  isolation decision. Failure to establish required isolation is
  fail-closed for operations that require it: a multi-user server never
  falls back to unconfined execution.
- **Single-user servers** run the agent with full host access by design.

## Non-boundaries

- Extensions are **not** mutually sandboxed; one extension can read
  another's data.
- Scoped stores (per-user settings/secrets/data paths) are **not** an
  enforcement boundary against installed extensions.
- Chat, markdown, and tool output are **untrusted content, not
  authorization**; treat model- or tool-produced text as data, never as a
  grant of permission.
- Outbound network access from jailed agents is not restricted, and one
  user's agent can still exhaust CPU, memory, or disk.

## Credential hygiene

- Unclaimed setup codes can appear in server/pod logs. Set
  `SIGRUN_SETUP_CODE` explicitly where log access is a concern, and treat
  logs as credential surfaces.
- API tokens are shown once at creation; the store keeps only digests.
  Rotate any token that has appeared in a log, transcript, or report.

## Verification limits

A local run on this host passed **19 unprivileged cases** in
`test/sandbox-it/boundary.test.ts` (Linux, Landlock ABI 7). The hosted-CI job
passes, but its current GitHub runner forbids unprivileged user/PID namespaces,
so it **skips all 21 cases rather than executing them**. This is an accepted
verification limitation, not evidence of hosted kernel-boundary coverage.

Two of those cases need more privilege than CI grants — the `osUser` success
case and the in-jail uid/gid-switch discrimination case. Both **pass in a
privileged run** (all 21 cases green in a container whose capability bounding
set carries `SETUID`/`SETGID`, with `SIGRUN_SANDBOX_IT_PRIVILEGED=1`). They are
**operator-verified, not CI-verified**: no hosted-CI job grants that privilege,
so CI continues to skip them. See [`sandbox/README.md`](sandbox/README.md) for
the boundary suite and runner details rather than this policy duplicating case
specifics.
