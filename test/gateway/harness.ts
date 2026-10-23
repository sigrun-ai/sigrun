/**
 * The gateway e2e harness (Task 1): the `host-conversations.test.ts`
 * boot shape — faux provider, token auth, claimed directory — with the
 * built-in gateway ON, the loopback channel fixture loaded, the
 * engine's `settings/gateway.json` written under the config dir, and
 * `startGateway` started (the serve composition's order: handle before
 * the server, engine start after it).
 *
 * `bootGateway(opts)` returns `GatewayBoot { opened, app, loop, faux,
 * tokens, shutdown(), waitFor(pred, ms?) }` — one hermetic boot per
 * call; the returned `shutdown()` runs the ordered steps (streams →
 * app → engine intake/stop → harness) and removes the tmpdir.
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import { loadConfig, type SigrunConfig } from "../../src/config.js";
import { openHarness, type OpenedHarness } from "../../src/harness/boot.js";
import { createServer } from "../../src/server/index.js";
import { startGateway, type GatewayHandle } from "../../src/server/gateway.js";
import { createShutdown } from "../../src/server/shutdown.js";
import { seededIdentity } from "../helpers/identity.js";

/** The loopback channel fixture (id `loop`, label `Loop`). */
export const LOOPBACK_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "..", "fixtures", "fixture-loopback-channel", "index.js"),
).href;

/** The loop handle the fixture installs on globalThis. */
export interface LoopHandle {
	readonly ctx: import("../../src/extension.js").ChannelContext | undefined;
	readonly sent: readonly import("../../src/extension.js").OutboundMessage[];
	readonly edits: readonly {
		ref: import("../../src/extension.js").MessageRef;
		message: import("../../src/extension.js").OutboundMessage;
	}[];
	readonly typing: readonly import("../../src/extension.js").ChatRef[];
	readonly commands: readonly {
		name: string;
		description: string;
	}[][];
	failNext(kind: string): void;
	hangNext(): void;
	inbound(
		event: import("../../src/extension.js").InboundEvent,
	): Promise<{ readonly outcome: "admitted" | "dropped" | "command" }>;
	tap(event: import("../../src/extension.js").ActionEvent): Promise<void>;
}

/** One booted gateway e2e server. */
export interface GatewayBoot {
	readonly opened: OpenedHarness;
	readonly app: FastifyInstance;
	readonly gateway: GatewayHandle;
	readonly loop: LoopHandle;
	readonly faux: FauxProviderHandle;
	readonly tokens: Readonly<Record<string, string>>;
	readonly config: SigrunConfig;
	readonly dir: string;
	/** The ordered shutdown + tmpdir removal (call exactly once). */
	shutdown(): Promise<void>;
	/** Poll `pred` until true (50 ms ticks, default 10 s ceiling). */
	waitFor(pred: () => boolean | Promise<boolean>, ms?: number): Promise<void>;
}

/** `bootGateway` options. */
export interface BootGatewayOptions {
	/** Extra settings-file fields (merged with `namingModel: false`). */
	readonly settings?: Record<string, unknown>;
	/** The `settings/gateway.json` body (the engine's scoped settings). */
	readonly gatewaySettings?: Record<string, unknown>;
	/** Directory users to seed (alice admin + tester by default). */
	readonly users?: readonly { user: string; admin?: boolean }[];
	/** The faux provider's response queue. */
	readonly responses?: readonly AssistantMessage[];
}

/**
 * Boot one gateway e2e server. The engine reads its config through its
 * scoped settings store — `<configDir>/settings/gateway.json` (the
 * config dir `SIGRUN_CONFIG_DIR` names; the boot env carries it) — so
 * `gatewaySettings` is written THERE, not under the test settings dir.
 */
export async function bootGateway(
	opts: BootGatewayOptions = {},
): Promise<GatewayBoot> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-e2e-"));
	const configDir = join(dir, "config");
	const faux = fauxProvider({
		provider: "faux",
		models: [
			{ id: "m", contextWindow: 128_000 },
			{ id: "m2", contextWindow: 128_000 },
		],
	});
	faux.setResponses(
		opts.responses === undefined
			? [fauxAssistantMessage("gateway answer")]
			: [...opts.responses],
	);
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "token",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: configDir,
	});
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({ namingModel: false, ...opts.settings }),
	);
	// The engine's scoped settings: the store-root chain puts extension
	// settings under `<configDir>/settings/`; the dir is created here (the
	// engine's read of an absent file is `{}` — writing the file is the
	// test's whole job).
	if (opts.gatewaySettings !== undefined) {
		await mkdir(join(configDir, "settings"), { recursive: true });
		await writeFile(
			join(configDir, "settings", "gateway.json"),
			JSON.stringify(opts.gatewaySettings),
		);
	}
	const identity = await seededIdentity(dir);
	// seededIdentity already claimed the dir with "tester" (admin); the
	// seed list only ADDS (the caller's users default [alice]); "tester"
	// in the list would collide with the seeded one.
	const seedUsers = opts.users ?? [{ user: "alice", admin: true }];
	for (const user of seedUsers) {
		if (user.user === "tester") continue;
		await identity.users.add({
			user: user.user,
			admin: user.admin ?? false,
			source: "cli",
		});
	}
	// The faux provider CONTRIBUTOR (the host-conversations pattern —
	// without it the boot registers the env-degenerate provider and every
	// run settles model_error).
	const opened = await openHarness(config, {
		identity,
		extensions: [{ name: "ext-faux", providers: [{ provider: faux.provider }] }],
		extensionSpecifiers: [LOOPBACK_SPECIFIER],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
	});
	const tokens: Record<string, string> = {};
	for (const user of ["tester", ...seedUsers.map((u) => u.user)]) {
		const { token } = await opened.identity.tokens.create(
			`${user}-cli`,
			user,
		);
		tokens[user] = token;
	}
	// serve.ts's composition: the handle exists BEFORE the server (the
	// meta route reaches it through ServerContext), and the engine starts
	// AFTER the server exists.
	const gateway = startGateway(opened);
	const app = await createServer(opened, config, [], {
		gateway,
		env: { SIGRUN_CONFIG_DIR: configDir },
	});
	await gateway.started;
	const loop = (globalThis as { __loop?: LoopHandle }).__loop;
	if (loop === undefined) {
		throw new Error("fixture-loopback-channel did not install globalThis.__loop");
	}
	const shutdown = async (): Promise<void> => {
		const ordered = createShutdown({
			endStreams: () => {
				app.sse.endAll();
			},
			closeApp: () => app.close(),
			gateway,
			eventBusShutdown: () =>
				opened.eventBus.shutdownSequence(BACKGROUND_CONTEXT),
			// stopProviderRefresh is sync (`() => void` — the scheduler's own
			// stop joins internally); the shutdown steps await every value, and
			// `undefined` satisfies `Promise<void>` only when wrapped.
			stopProviderRefresh: async () => {
				opened.stopProviderRefresh();
			},
			closeHarness: () => opened.harness.close(BACKGROUND_CONTEXT),
		});
		await ordered();
		await rm(dir, { recursive: true, force: true });
	};
	const waitFor = async (
		pred: () => boolean | Promise<boolean>,
		ms = 10_000,
	): Promise<void> => {
		const deadline = Date.now() + ms;
		for (;;) {
			if (await pred()) return;
			if (Date.now() > deadline) {
				throw new Error("bootGateway.waitFor: predicate never became true");
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	return {
		opened,
		app,
		gateway,
		loop,
		faux,
		tokens,
		config,
		dir,
		shutdown,
		waitFor,
	};
}
