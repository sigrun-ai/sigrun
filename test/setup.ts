/**
 * The suite-wide environment pin (core hardening W1 Task 4): an
 * UNCLAIMED boot writes the setup code to `<cacheDir>/setup-code`
 * (`boot.ts` → `ensureSetupCode`). Dozens of existing tests open
 * harnesses without an identity seed — without this pin every one of
 * those boots would drop a code file into the developer's real
 * `~/.cache/sigrun`. Pinned per worker process to a fresh tmp dir,
 * BEFORE any test imports boot.
 *
 * Only the CACHE root needs the pin: state/config stay per-test (the
 * identity stores materialize lazily and the boot harnesses pass their
 * own SIGRUN_* env). Tests that pass an explicit SIGRUN_CACHE_DIR (e.g.
 * the onboarding suite) override this default through their own env
 * objects.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SIGRUN_CACHE_DIR = mkdtempSync(
	join(tmpdir(), "sigrun-vitest-cache-"),
);
