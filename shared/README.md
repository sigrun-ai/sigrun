# @sigrun/shared

The pure client-shared leaf of [sigrun](https://github.com/sigrun-ai/sigrun):
theme tokens, turn/conversation shaping, and the channel wire types —
consumed by the webui, the TUI, and the server. Zero runtime dependencies;
every subpath is a types+code pair (`@sigrun/shared/themes`, `/conversations`,
`/turns`, …) exported from `dist`.

Part of the sigrun workspace; published from the repository root as
`@sigrun/shared` (see the root `CHANGELOG.md` for release history).
