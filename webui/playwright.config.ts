import { defineConfig, devices } from "@playwright/test";

/**
 * M2 ship-gate E2E (Task 26b, spec §7): real-browser tests against the real
 * M1 server booted by e2e/harness.ts. Run via `npm run test:e2e` (root) —
 * that script builds the bundle fresh before invoking this suite, so the
 * served webui/dist always matches the current src.
 *
 * The server boots per spec file (beforeAll), so the per-test timeout is
 * generous. Serial workers: every test owns a full harness + Fastify
 * listener; parallelism buys little at this suite size and invites port /
 * tmpdir contention.
 */
export default defineConfig({
	testDir: "e2e",
	timeout: 120_000,
	expect: { timeout: 10_000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	use: {
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
