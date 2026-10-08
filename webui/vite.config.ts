import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
});
