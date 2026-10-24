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
		exclude: [
			...defaultExclude,
			"webui/**",
			"tui/**",
			".worktrees/**",
			".docker-ext/**",
			// Kernel integration is opt-in and ABI-gated. CI's sandbox-it job
			// asserts ABI >= 6 before enabling it; ordinary npm test never loads it.
			...(process.env.SIGRUN_SANDBOX_IT === "1" ? [] : ["test/sandbox-it/**"]),
		],
		// The suite-wide env pin (test/setup.ts): the unclaimed-boot setup-code
		// write lands in a tmp cache root, never the developer's ~/.cache/sigrun.
		setupFiles: ["./test/setup.ts"],
	},
});
