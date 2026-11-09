/**
 * The suite-wide environment pin (core hardening W1 Task 4): an
 * UNCLAIMED boot writes the setup code to `<cacheDir>/setup-code`
 * (`boot.ts` → `ensureSetupCode`). Dozens of existing tests open
 * harnesses without an identity seed — without this pin every one of
 * those boots would drop a code file into the developer's real
 * `~/.cache/sigrun`. Pinned per worker process to a fresh tmp dir,
 * BEFORE any test imports boot.
 *
 * The CONFIG root is pinned too (settings rework, Task 11 fix): the
 * built-in MCP factory imports a legacy mcp.json into its scoped settings
 * and secrets stores, so a default-builtins boot without an explicit
 * config root would otherwise write into the developer's real
 * ~/.config/sigrun. SIGRUN_MCP_CONFIG points at an absent file in the
 * same tmp root; suites exercising the import override it per test.
 * Tests with explicit SIGRUN_* env objects override these defaults.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SIGRUN_CACHE_DIR = mkdtempSync(
	join(tmpdir(), "sigrun-vitest-cache-"),
);
const configDir = mkdtempSync(join(tmpdir(), "sigrun-vitest-config-"));
process.env.SIGRUN_CONFIG_DIR = configDir;
process.env.SIGRUN_MCP_CONFIG = join(configDir, "no-legacy-mcp.json");
