import { test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("dbg recall via the SERVER route", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dbg-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 128000 }] });
  faux.setResponses([
    fauxAssistantMessage("marker: ZEBRA-COMPACTED-OUT"),
    fauxAssistantMessage("second turn"),
    fauxAssistantMessage([{ type: "text", text: "checking memory" }, fauxToolCall("memory_recall", { query: "ZEBRA" }, { id: "call-recall" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("recall returned the marker"),
  ]);
  const config = loadConfig({ SIGRUN_MODEL: "faux/m", SIGRUN_STORAGE_PATH: join(dir, "s.db"), SIGRUN_WORKSPACE_PATH: dir });
  const opened = await openHarness(config, {
    extensions: [{ name: "ext-faux", providers: [{ provider: faux.provider }] }],
    env: {},
    extensionSpecifiers: ["sigrun-ext-memory"],
  });
  const app = await createServer(opened, config);
  const root = await opened.harness.root(BACKGROUND_CONTEXT, { agent: { model: opened.defaultModel } });
  for (const text of ["remember ZEBRA", "another turn", "what was the marker?"]) {
    const resp = await app.inject({ method: "POST", url: `/v1/conversations/${root.id}/submissions`, payload: { input: [{ type: "text", text }] } });
    console.log("submit", JSON.stringify(text), "->", resp.statusCode);
  }
  const view = await root.viewState(BACKGROUND_CONTEXT);
  console.log("KINDS: " + JSON.stringify(view.value.entries.map((e: any) => e.kind)));
  const tr = view.value.entries.filter((e: any) => e.kind === "pi.tool-result");
  console.log("tool-results:", tr.length, tr.length > 0 ? JSON.stringify(tr[0].model?.[0]?.content).slice(0, 200) : "");
  await app.close();
  await opened.harness.close(BACKGROUND_CONTEXT);
});
