// Shared fetch-backed fixture for the provider management UI. Tests own
// every provider, extension, and URL literal.
import {
  createClient,
  type AuthCheckProviderWire,
  type ExtensionInfoWire,
  type FetchLike,
} from "../api";

export interface ProviderFixture {
  readonly providers: readonly AuthCheckProviderWire[];
  readonly extensions: readonly ExtensionInfoWire[];
}

export function makeProviderFixture(input?: {
  readonly providers?: readonly AuthCheckProviderWire[];
  readonly withOrdinaryExtension?: boolean;
  readonly withoutExtensions?: boolean;
}) {
  const providers: AuthCheckProviderWire[] = input?.providers?.map((row) => ({
    ...row,
  })) ?? [
    {
      provider: "acme-chat",
      kind: "chat",
      owner: "acme-providers",
      status: "ready",
      models: 2,
      modelIds: ["chat-1", "chat-2"],
      local: false,
    },
    {
      provider: "acme-judge",
      kind: "decision",
      owner: "acme-providers",
      status: "not_configured",
      models: 1,
      modelIds: ["judge-1"],
      local: false,
    },
  ];
  const extensions: ExtensionInfoWire[] = input?.withoutExtensions === true ? [] : [
    {
      name: "acme-providers",
      title: "Acme Providers",
      provider: true,
      settingsPage: true,
      status: "ok",
      interactionKinds: [],
      ambientKeys: [],
      workers: [],
      services: [],
    },
    ...(input?.withOrdinaryExtension === true
      ? [
          {
            name: "acme-tools",
            title: "Acme Tools",
            settingsPage: true as const,
            status: "ok",
            interactionKinds: [],
            ambientKeys: [],
            workers: [],
            services: [],
          },
        ]
      : []),
  ];
  const calls: {
    input: string;
    method?: string;
    body?: string | Uint8Array;
  }[] = [];
  const sections = [
    {
      slug: "core",
      id: "general",
      title: "General",
      icon: "key",
      group: "system" as const,
    },
    {
      slug: "core",
      id: "interface",
      title: "Interface",
      icon: "image",
      group: "mine" as const,
    },
    {
      slug: "core",
      id: "providers",
      title: "Providers",
      icon: "cloud",
      group: "system" as const,
    },
    {
      slug: "acme-providers",
      id: "settings",
      page: "acme-providers",
      title: "Settings",
      icon: "key",
      group: "system" as const,
      admin: true,
    },
  ];
  const providerForm = {
    v: 1,
    root: {
      type: "form",
      id: "core-providers-form",
      bind: "/settings",
      mode: "submit",
      onSubmit: "save",
      submitLabel: "Save",
      children: [
        {
          type: "section",
          id: "core-providers-defaults",
          title: "Defaults",
          children: [
            {
              type: "text",
              name: "defaultProvider.baseUrl",
              label: "Default provider base URL",
            },
            {
              type: "number",
              name: "server.providers.refreshIntervalMinutes",
              label: "Model catalog refresh (minutes)",
            },
          ],
        },
      ],
    },
  };
  const fetchImpl: FetchLike = (input, request) => {
    calls.push({ input, method: request?.method, body: request?.body });
    let body: unknown = {};
    if (input === "/v1/meta")
      body = { version: "0.1.0", harnessVersion: "1.0.0" };
    else if (input === "/v1/settings/sections") body = { sections, index: [] };
    else if (input === "/v1/extensions") body = { extensions };
    else if (input === "/v1/providers") body = { providers };
    else if (input === "/v1/extensions/acme-providers/settings")
      body = { settings: {}, pendingRestart: [] };
    else if (
      input === "/v1/ext/core/surfaces/providers" &&
      request?.method !== "POST"
    )
      body = {
        tree: providerForm,
        data: {
          settings: {
            "defaultProvider.baseUrl": "https://acme.example.invalid/v1",
            "server.providers.refreshIntervalMinutes": 15,
          },
        },
        rev: 0,
        treeRev: 0,
        access: "write",
      };
    else if (input === "/v1/ext/core/surfaces/providers/data")
      body = {
        rev: 0,
        treeRev: 0,
        data: {
          settings: {
            "defaultProvider.baseUrl": "https://acme.example.invalid/v1",
            "server.providers.refreshIntervalMinutes": 15,
          },
        },
      };
    else if (input === "/v1/ext/core/surfaces/providers/actions")
      body = { ok: true, rev: 1 };
    else if (input.startsWith("/v1/ext/acme-providers/surfaces/settings/data"))
      body = { rev: 0, treeRev: 0, data: { settings: {} } };
    else if (input.startsWith("/v1/ext/acme-providers/surfaces/settings"))
      body = {
        tree: {
          v: 1,
          root: {
            type: "form",
            id: "acme-settings",
            bind: "/settings",
            mode: "submit",
            onSubmit: "save",
            children: [],
          },
        },
        data: { settings: {} },
        rev: 0,
        treeRev: 0,
        access: "write",
      };
    else if (
      request?.method === "PUT" &&
      input.match(/^\/v1\/providers\/local\/[^/]+$/)
    ) {
      const local = (JSON.parse(request.body as string) as { local: boolean })
        .local;
      const owner = input.slice("/v1/providers/local/".length);
      for (let index = 0; index < providers.length; index++)
        if ((providers[index].owner ?? "core") === owner)
          providers[index] = { ...providers[index], local };
      body = { local };
    } else if (
      request?.method === "POST" &&
      input.match(/^\/v1\/providers\/[^/]+\/refresh$/)
    ) {
      body = providers.find((row) => row.provider === input.split("/")[3]);
    } else
      throw new Error(`unexpected fetch ${request?.method ?? "GET"} ${input}`);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  };
  return {
    calls,
    providers,
    client: createClient({ fetch: fetchImpl, rawFetch: fetchImpl as never }),
  };
}
