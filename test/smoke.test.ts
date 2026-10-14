import { expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
test("loadConfig requires the default model (env or file)", () => {
  expect(() => loadConfig({ OPENAI_BASE_URL: "x", OPENAI_API_KEY: "y" })).toThrow(/SIGRUN_DEFAULT_MODEL/);
});

test("SIGRUN_DEFAULT_MODEL provider/model pins both parts (first slash splits)", () => {
  const config = loadConfig({ SIGRUN_DEFAULT_MODEL: "acme/model-1" });
  expect(config.models).toEqual({ provider: "acme", modelId: "model-1" });
});

test("deprecated alias SIGRUN_MODEL still reads the model", () => {
  const config = loadConfig({ SIGRUN_MODEL: "acme/model-1" });
  expect(config.models).toEqual({ provider: "acme", modelId: "model-1" });
});

test("bare model id defaults to the env OpenAI-compat provider", () => {
  const config = loadConfig({ SIGRUN_DEFAULT_MODEL: "gpt-4o" });
  expect(config.models).toEqual({ provider: "openai", modelId: "gpt-4o" });
});

test("defaults: storage path, extensions dir, port, no backup", () => {
  const config = loadConfig({ SIGRUN_DEFAULT_MODEL: "openai/gpt-4o" });
  expect(config.storagePath).toBe("data/sigrun.db");
  expect(config.extensionsDir).toBe("extensions");
  expect(config.port).toBe(3000);
  expect(config.backup).toBeUndefined();
});

test("SIGRUN_* overrides apply", () => {
  const config = loadConfig({
    SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
    SIGRUN_STORAGE_PATH: "/var/lib/sigrun/sigrun.db",
    SIGRUN_EXTENSIONS_DIR: "/opt/sigrun/extensions",
    SIGRUN_PORT: "8080",
  });
  expect(config.storagePath).toBe("/var/lib/sigrun/sigrun.db");
  expect(config.extensionsDir).toBe("/opt/sigrun/extensions");
  expect(config.port).toBe(8080);
});

test("SIGRUN_PORT rejects non-positive or non-integer values", () => {
  expect(() => loadConfig({ SIGRUN_DEFAULT_MODEL: "m", SIGRUN_PORT: "0" })).toThrow(/SIGRUN_PORT/);
  expect(() => loadConfig({ SIGRUN_DEFAULT_MODEL: "m", SIGRUN_PORT: "abc" })).toThrow(/SIGRUN_PORT/);
});

test("SIGRUN_DEFAULT_MODEL rejects empty provider or model id", () => {
  expect(() => loadConfig({ SIGRUN_DEFAULT_MODEL: "openai/" })).toThrow(/SIGRUN_DEFAULT_MODEL/);
  expect(() => loadConfig({ SIGRUN_DEFAULT_MODEL: "/gpt-4o" })).toThrow(/SIGRUN_DEFAULT_MODEL/);
});
