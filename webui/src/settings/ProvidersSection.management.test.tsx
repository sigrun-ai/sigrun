import { act } from "react";
import { useState } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test } from "vitest";
import type {
  createClient,
  ExtensionInfoWire,
} from "../api";
import { renderAsync, textContent } from "../test-utils";
import {
  useTheme,
  type ThemeRoot,
  type ThemeState,
  type ThemeStorage,
} from "../theme/useTheme";
import { SettingsPanel } from "./SettingsPanel";
import { usePrefs } from "./usePrefs";
import { ExtensionPage } from "./ExtensionPage";
import { makeProviderFixture } from "./provider-fixture";

export function renderProviderPanel(
  client: ReturnType<typeof createClient>,
  section = "providers",
): Promise<TestRenderer.ReactTestRenderer> {
  const storage = new Map<string, string>();
  const themeStorage: ThemeStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, value);
    },
  };
  const dataset: Record<string, string | undefined> = {};
  const root: ThemeRoot = { dataset, setProperty: () => undefined };
  const query = {
    matches: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  function Probe() {
    const prefs = usePrefs();
    const theme: ThemeState = useTheme({
      storage: themeStorage,
      root,
      matchMedia: () => query,
    });
    const [open, setOpen] = useState(section);
    return (
      <SettingsPanel
        client={client}
        prefsState={prefs}
        theme={theme}
        admin
        section={open}
        onSection={setOpen}
      />
    );
  }
  return renderAsync(<Probe />);
}

describe("provider management", () => {
  test("Providers lists one row per provider extension", async () => {
    const renderer = await renderProviderPanel(makeProviderFixture().client);
    const rows = renderer.root.findAllByProps({
      className: "settings-provider-owner",
    });
    expect(rows).toHaveLength(1);
    expect(textContent(renderer.toJSON())).toContain("Acme Providers");
    expect(textContent(renderer.toJSON())).toContain("acme-chat");
    expect(textContent(renderer.toJSON())).toContain("acme-judge");
  });

  test("the core provider form saves through the core surface", async () => {
    const harness = makeProviderFixture();
    const renderer = await renderProviderPanel(harness.client);
    const input = renderer.root.findByProps({ "aria-label": "Default provider base URL" });
    await act(async () => { input.props.onChange({ target: { value: "https://acme-other.example.invalid/v1" } }); });
    await act(async () => { renderer.root.findByProps({ className: "blk-form-submit" }).props.onClick(); });
    const action = harness.calls.find((call) => call.input === "/v1/ext/core/surfaces/providers/actions");
    expect(action?.method).toBe("POST");
    expect(JSON.parse(String(action?.body))).toMatchObject({ payload: { values: {
      "defaultProvider.baseUrl": "https://acme-other.example.invalid/v1",
      "server.providers.refreshIntervalMinutes": 15,
    } } });
  });

  test("Refresh shows on chat rows only", async () => {
    const harness = makeProviderFixture();
    const renderer = await renderProviderPanel(harness.client);
    const owner = renderer.root.findByProps({
      className: "settings-provider-owner",
    });
    const refresh = owner.findAllByProps({
      className: "settings-provider-refresh",
    });
    expect(refresh).toHaveLength(1);
    expect(refresh[0].props["data-provider"]).toBe("acme-chat");
    await act(async () => {
      await refresh[0].props.onClick();
    });
    expect(
      harness.calls.some(
        (call) =>
          call.input === "/v1/providers/acme-chat/refresh" &&
          call.method === "POST",
      ),
    ).toBe(true);
    expect(
      harness.calls.some(
        (call) => call.input === "/v1/providers/acme-judge/refresh",
      ),
    ).toBe(false);
  });

  test("the env-driven provider gets a locality-only row", async () => {
    const harness = makeProviderFixture({
      providers: [
        {
          provider: "acme-env",
          status: "ready",
          models: 1,
          modelIds: ["env-1"],
          local: false,
        },
      ],
    });
    const renderer = await renderProviderPanel(harness.client);
    expect(textContent(renderer.toJSON())).toContain(
      "Default provider (environment)",
    );
    const owner = renderer.root.findByProps({
      className: "settings-provider-owner",
    });
    expect(
      owner.findAllByProps({ className: "settings-provider-refresh" }),
    ).toHaveLength(0);
    expect(
      owner.findAllByProps({ className: "settings-provider-key" }),
    ).toHaveLength(0);
    expect(
      owner.findByProps({ className: "settings-provider-page-link" }).props[
        "data-owner"
      ],
    ).toBe("core");
  });

  test("provider extensions are not under Extensions", async () => {
    const renderer = await renderProviderPanel(
      makeProviderFixture({ withOrdinaryExtension: true }).client,
    );
    const extensionGroups = renderer.root.findAllByProps({
      role: "group",
      "aria-label": "Extensions",
    });
    expect(extensionGroups).toHaveLength(1);
    expect(
      extensionGroups[0]
        .findAllByType("button")
        .map((node) => node.props.children),
    ).toEqual(["Acme Tools"]);
    const providersGroup = renderer.root.findByProps({ role: "group", "aria-label": "Providers" });
    expect(providersGroup.findAllByType("button").map((node) => node.props.children)).toEqual(["Acme Providers"]);
    expect(renderer.root.findByProps({ role: "group", "aria-label": "System settings" }).findAllByType("button").some((node) => node.props.children === "Providers")).toBe(true);
    expect(textContent(renderer.toJSON())).toContain("Acme Providers");
  });
});

describe("provider extension page", () => {
  const extension: ExtensionInfoWire = {
    name: "acme-providers",
    title: "Acme Providers",
    provider: true,
    settingsPage: true,
    status: "ok",
    interactionKinds: [],
    ambientKeys: [],
    workers: [],
    services: [],
  };
  const providerSections = [
    {
      slug: "acme-providers",
      id: "settings",
      page: "acme-providers",
      title: "Settings",
      icon: "key",
      admin: true,
      group: "system" as const,
    },
  ];

  test("Runs locally toggles through the API", async () => {
    const harness = makeProviderFixture();
    const renderer = await renderAsync(
      <ExtensionPage
        client={harness.client}
        extension={extension}
        sections={providerSections}
        admin
      />,
    );
    const toggle = renderer.root.findByProps({
      className: "settings-provider-local",
    });
    expect(toggle.props.checked).toBe(false);
    await act(async () => {
      toggle.props.onChange({ target: { checked: true } });
    });
    expect(harness.calls).toContainEqual({
      input: "/v1/providers/local/acme-providers",
      method: "PUT",
      body: JSON.stringify({ local: true }),
    });
    expect(
      renderer.root.findByProps({ className: "settings-provider-local" }).props
        .checked,
    ).toBe(true);
  });

  test("provider page lists models by kind", async () => {
    const harness = makeProviderFixture();
    const renderer = await renderAsync(
      <ExtensionPage
        client={harness.client}
        extension={extension}
        sections={providerSections}
        admin
      />,
    );
    const models = renderer.root.findByProps({
      "data-extension-part": "models",
    });
    expect(
      models.findAll(
        (node) => node.type === "h4" && node.children.includes("chat"),
      ),
    ).toHaveLength(1);
    expect(
      models.findAll(
        (node) => node.type === "h4" && node.children.includes("decision"),
      ),
    ).toHaveLength(1);
    for (const model of [
      "acme-chat/chat-1",
      "acme-chat/chat-2",
      "acme-judge/judge-1",
    ]) {
      expect(
        models.findAll(
          (node) =>
            node.type === "li" &&
            JSON.stringify(node.children) ===
              JSON.stringify([model.split("/")[0], "/", model.split("/")[1]]),
        ),
      ).toHaveLength(1);
    }
    expect(
      renderer.root
        .findByProps({ "data-extension-part": "models" })
        .findAllByProps({ className: "settings-provider-refresh" }),
    ).toHaveLength(0);
  });

  test("the system-default credential carries its label", async () => {
    const harness = makeProviderFixture({
      providers: [
        {
          provider: "acme-chat",
          kind: "chat",
          owner: "acme-providers",
          status: "ready",
          models: 1,
          modelIds: ["chat-1"],
          systemDefault: true,
          local: false,
        },
      ],
    });
    const renderer = await renderAsync(
      <ExtensionPage
        client={harness.client}
        extension={extension}
        sections={providerSections}
        admin
      />,
    );
    expect(textContent(renderer.toJSON())).toContain(
      "Credential (also used by the system default model)",
    );
  });

  test("the env deep link opens without installed extensions", async () => {
    const harness = makeProviderFixture({ withoutExtensions: true, providers: [] });
    const renderer = await renderProviderPanel(harness.client, "core");
    expect(renderer.root.findByProps({ "data-extension-page": "core" })).toBeDefined();
    expect(renderer.root.findByProps({ className: "settings-provider-local" })).toBeDefined();
  });

  test("the default credential is labelled and env pages have locality only", async () => {
    const harness = makeProviderFixture({
      withoutExtensions: true,
      providers: [{
        provider: "acme-env",
        status: "ready",
        models: 1,
        modelIds: ["env-1"],
        systemDefault: true,
        local: false,
      }],
    });
    const renderer = await renderAsync(
      <ExtensionPage
        client={harness.client}
        extension={{
          ...extension,
          name: "core",
          title: "Default provider (environment)",
          provider: undefined,
          settingsPage: undefined,
        }}
        sections={[]}
        admin
      />,
    );
    expect(
      renderer.root.findAllByProps({ className: "settings-provider-key" }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ "data-extension-part": "settings" }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ "data-extension-part": "advanced" }),
    ).toHaveLength(0);
    expect(
      renderer.root.findByProps({ className: "settings-provider-local" }),
    ).toBeDefined();
    expect(textContent(renderer.toJSON())).not.toContain(
      "Credential (also used by the system default model)",
    );
  });
});
