/**
 * M2 transport spike: boot the M1 §5 server over the faux provider on a real
 * port, so the spike webui (spikes/webui-transport/index.html) can drive the
 * §5 endpoints + SSE view stream from a browser. Not a test — a manual spike.
 *
 * Run: npx tsx spikes/webui-transport/serve-spike.ts [port]
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { openHarness } from "../../src/harness/boot.js";
import type { ProviderContributor } from "../../src/harness/providers/index.js";
import { createServer } from "../../src/server/index.js";

const port = Number(process.argv[2] ?? 4173);
const dir = await mkdtemp(join(tmpdir(), "sigrun-spike-"));

// The faux provider: deterministic answers, no network.
const faux = fauxProvider({
	provider: "faux",
	models: [{ id: "m", contextWindow: 128_000 }],
});
faux.setResponses([
	fauxAssistantMessage("spike answer one"),
	fauxAssistantMessage("spike answer two"),
]);
const contributor: ProviderContributor = {
	name: "ext-faux",
	providers: [{ provider: faux.provider }],
};

const config = loadConfig({
	SIGRUN_MODEL: "faux/m",
	SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
	SIGRUN_WORKSPACE_PATH: dir,
	SIGRUN_PORT: String(port),
});
const opened = await openHarness(config, {
	extensions: [contributor],
	env: {},
});
const app = await createServer(opened, config);

// The spike webui is served cross-origin from the Vite dev server / file://,
// so allow the §5 endpoints from anywhere (spike only — the real deployment
// serves the webui bundle from the same origin per §4.1/§6).
app.addHook("onSend", async (_request, reply) => {
	reply.header("access-control-allow-origin", "*");
	reply.header("access-control-allow-headers", "content-type");
	reply.header("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
});
app.options("/*", async (_request, reply) => reply.code(204).send());

await app.listen({ port, host: "127.0.0.1" });
console.log(`sigrun spike server on http://127.0.0.1:${port} (storage: ${dir})`);
