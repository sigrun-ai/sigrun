import react from "@vitejs/plugin-react";
import { defaultExclude, defineConfig } from "vitest/config";

// The webui is a CHANNEL BUNDLE (spec §4.1/§6): deploy-time static assets the
// sigrun server mounts at "/" (see src/server/static.ts). `base: "./"` keeps
// asset URLs relative so the bundle works under any mount path a deploy
// chooses (and from a plain file-system dist/ directory in tests).
export default defineConfig({
	base: "./",
	plugins: [react()],
	build: {
		outDir: "dist",
	},
	test: {
		// e2e/ is the Playwright suite (`npm run test:e2e`); vitest owns src/.
		exclude: [...defaultExclude, "e2e/**"],
	},
});
