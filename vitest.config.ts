import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// The webui workspace runs its own vitest (npm run test -w
		// @sigrun/webui); each suite runs exactly once, and the webui suite
		// does not inherit the server's node-environment config.
		exclude: [...defaultExclude, "webui/**"],
	},
});
