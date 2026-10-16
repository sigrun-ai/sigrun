import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// The workspace suites run their own vitest (npm run test -w
		// @sigrun/webui / @sigrun/tui); each suite runs exactly once, and
		// the workspace suites do not inherit the server's node-environment
		// config.
		// `.docker-ext/**`: build-time vendored scratch (gitignored; created by
		// scripts/docker-vendor-exts.sh for the image build) — never a test
		// source; its vendored tests mirror the real ones and their deps differ.
		exclude: [...defaultExclude, "webui/**", "tui/**", ".worktrees/**", ".docker-ext/**"],
	},
});
