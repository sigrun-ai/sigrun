import { test } from "vitest";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("dbg boot memorySubmit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dbg-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 128000 }] });
  faux.setResponses([fauxAssistantMessage("ok")]);
  const config = loadConfig({ SIGRUN_MODEL: "faux/m", SIGRUN_STORAGE_PATH: join(dir, "s.db"), SIGRUN_WORKSPACE_PATH: dir });
  const opened = await openHarness(config, {
    extensions: [{ name: "ext-faux", providers: [{ provider: faux.provider }] }],
    env: {},
    extensionSpecifiers: ["sigrun-ext-memory"],
  });
  console.log("memorySubmit present:", opened.memorySubmit !== undefined);
  console.log("extensionOutcomes:", JSON.stringify(opened.extensionOutcomes));
  await opened.harness.close({} as any);
});
