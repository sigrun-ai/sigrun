# Why sigrun exists

Sigrun is a self-hosted, multi-user personal-assistant server. This document
is the rationale behind its design; the README is the *what* and *how*.

## The problem

A personal assistant that is actually useful does more than answer one-off
questions. It researches, follows up on its own research, runs scheduled
chores, remembers context across weeks, and answers from whatever device is
at hand. Most self-hosted agents are built for exactly one owner, so a
household or small team that wants one either runs a copy per person or
shares one agent and everything it can reach. A shared assistant needs three
properties that most agent stacks don't offer together:

- **Shared, not cloned.** Several people should be able to use one install,
  each with their own conversations, settings, credentials, and tools,
  without any of them reaching the others' or the server's.
- **Replaceable parts.** Memory, integrations, tools, and providers should
  be individually swappable packages, not forks of a monolith. An assistant
  you can't take apart is one you eventually have to replace wholesale.
- **One loop, many surfaces.** When the web UI re-implements its own agent
  loop beside the CLI's, the two drift: separate state paths, separate bugs,
  separate behavior. The agent loop should exist exactly once, with every
  surface a thin client. A conversation you started at your desk should be
  continuable from your phone, exactly where it stopped, even across a
  restart.

## Why multi-user is in core

Sharing an assistant safely is mostly isolation work, so sigrun does it in
core rather than leaving it to each deployment. Every request authenticates
into a user: an API token, a trusted proxy, or OIDC, GitHub, or Discord
sign-in through the built-in OAuth extension. The first admin claims the
install, and every later user is an invite. Extensions can offer per-user
tools, settings, secrets, and services, and core checks the conversation's
owner every time one of them runs. Each user's agent runs in its own
Landlock execution jail, and a second user is refused outright when that
jail is unavailable.

## Why extensions

The design goal is a small core with well-defined seams and an ecosystem,
not a platform. Extensions install as ordinary npm packages and contribute
tools, providers, prompt sections, UI blocks, credentials, and per-user
services. Memory systems, gateway/channel adapters, and login providers are
extensions — core does not privilege one implementation of any of them.
Install only extensions you trust: they run in-process with the server.

## Why one loop, on pi-durable

Sigrun is built on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable)
because it makes the "second agent loop" problem structurally impossible.
Conversations, submissions, retries, compaction, and crash recovery live in
the harness; the web UI, terminal UI, HTTP API, scheduled jobs, and (via
the gateway extension) chat channels are all clients submitting to and
watching the same conversations. A restart resumes where the process
stopped rather than losing the run.

## Trade-offs, stated plainly

- **Single process, single store.** One harness owns its SQLite database.
  That buys simplicity and crash-consistent state at the cost of
  horizontal scaling; sigrun is a personal/household server, not a
  multi-tenant SaaS.
- **Multi-user means isolation work.** Sharing one assistant across people
  requires real authentication and a per-user execution jail (Landlock on
  Linux). Sigrun fails closed when required isolation is unavailable rather
  than quietly running everyone's agent with full host access. Single-user
  installs skip all of this.
- **Evolving contracts.** Sigrun is 0.x. The extension and settings
  contracts are useful and exercised, but they can still change between
  minor releases. See [`SECURITY.md`](../SECURITY.md) for the support and verification
  posture, including what has and has not been verified.
