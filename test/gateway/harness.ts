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
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import { loadConfig, type SigrunConfig } from "../../src/config.js";
import { openHarness, type OpenedHarness } from "../../src/harness/boot.js";
import { createServer } from "../../src/server/index.js";
import { startGateway, type GatewayHandle } from "../../src/server/gateway.js";
import { createShutdown } from "../../src/server/shutdown.js";
import { seededIdentity, unclaimedIdentity } from "../helpers/identity.js";

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
	readonly responses?: readonly FauxResponseStep[];
	/** Optional faux streaming rate (a slow stream opens a live-frame window). */
	readonly tokensPerSecond?: number;
	/** Compaction env values, mapped to the loadConfig environment. */
	readonly compactionEnv?: {
		readonly keepRecentTokens?: number;
		readonly backgroundTokens?: number;
	};
	/**
	 * A CALLER-OWNED stores root for the harness's state (the engine's
	 * `host.stores.paths.state` roots here too): two boots over the same
	 * dir share the engine's persisted state (the restart e2e). Absent →
	 * the boot owns its own tmpdir and removes it at shutdown.
	 */
	readonly storesDir?: string;
	/**
	 * Boot with an UNCLAIMED directory (the claimed-gate e2e): no seeds,
	 * no tokens — the engine reads the empty directory in-process
	 * through `host.users.list()` (the HTTP surface 403s setup_required
	 * under any auth, so the test drives the loopback fixture directly).
	 */
	readonly unclaimed?: boolean;
	/**
	 * Auth env overrides (the C8 proxy e2e): spread OVER the default
	 * `SIGRUN_AUTH: "token"` — e.g. `{ SIGRUN_AUTH: "proxy",
	 * SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16" }`.
	 */
	authEnv?: Record<string, string | undefined>;
	/**
	 * The settings-file `server.auth` section, threaded into loadConfig
	 * (adminGroups for the proxy e2e's group grant).
	 */
	readonly serverAuth?: Record<string, unknown>;
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
	const dir = opts.storesDir ?? (await mkdtemp(join(tmpdir(), "sigrun-gw-e2e-")));
	const ownedDir = opts.storesDir === undefined;
	const configDir = join(dir, "config");
	const faux = fauxProvider({
		provider: "faux",
		...(opts.tokensPerSecond === undefined ? {} : { tokensPerSecond: opts.tokensPerSecond }),
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
	// The durable roots ALWAYS root inside the boot's dir: the engine's
	// gateway state lives at `<stateDir>/<slug>/gateway`, and an unset
	// root would leak test seen-ids into the operator's real
	// `~/.local/state/sigrun` (a later boot would then read yesterday's
	// committed ids — a cross-test pollution class). A caller-supplied
	// storesDir makes two boots share those roots (the restart e2e).
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "token",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: configDir,
		SIGRUN_DATA_DIR: dir,
		SIGRUN_STATE_DIR: dir,
		SIGRUN_CACHE_DIR: dir,
		...(opts.compactionEnv?.keepRecentTokens === undefined
			? {}
			: { SIGRUN_COMPACTION_KEEP_RECENT_TOKENS: String(opts.compactionEnv.keepRecentTokens) }),
		...(opts.compactionEnv?.backgroundTokens === undefined
			? {}
			: { SIGRUN_COMPACTION_BACKGROUND_TOKENS: String(opts.compactionEnv.backgroundTokens) }),
		...(opts.authEnv ?? {}),
	},
		opts.serverAuth === undefined
			? undefined
			: ({ server: { auth: opts.serverAuth } } as Parameters<
					typeof loadConfig
			  >[1]),
	);
	// The settings file lives at the CONFIG root (the same dir
	// `SIGRUN_CONFIG_DIR` names — where SettingsStore and AuthStore read
	// it). With a caller-supplied storesDir the config root is INSIDE it,
	// so a second boot over the dir re-reads it; the owned-dir boot
	// simply writes its own tmp config root.
	await mkdir(configDir, { recursive: true });
	await writeFile(
		join(configDir, "settings.json"),
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
	if (opts.storesDir !== undefined) {
		// A caller-supplied stores root is shared across boots (the
		// restart e2e): the durable roots (SIGRUN_*_DIR in the config load)
		// point inside it, so a second boot over the same dir reads the
		// first boot's persisted engine state (`<stateDir>/<slug>/gateway`
		// — the seen set). The boot never removes the dir at shutdown.
		await mkdir(join(opts.storesDir, "state"), { recursive: true });
		await mkdir(join(opts.storesDir, "data"), { recursive: true });
	}
	const identity = opts.unclaimed
		? await unclaimedIdentity(dir)
		: await seededIdentity(dir);
	// seededIdentity already claimed the dir with "tester" (admin); the
	// seed list only ADDS (the caller's users default [alice]); "tester"
	// in the list would collide with the seeded one. An unclaimed boot
	// seeds NOTHING (the empty directory IS the posture under test).
	const seedUsers = opts.unclaimed
		? []
		: (opts.users ?? [{ user: "alice", admin: true }]);
	for (const user of seedUsers) {
		if (user.user === "tester") continue;
		// Idempotent: a second boot over the SAME config root (the restart
		// e2e) re-seeds — the user already exists, so the add is skipped.
		if ((await identity.users.get(user.user)) === undefined) {
			await identity.users.add({
				user: user.user,
				admin: user.admin ?? false,
				source: "cli",
			});
		}
	}
	// The faux provider CONTRIBUTOR (the host-conversations pattern —
	// without it the boot registers the env-degenerate provider and every
	// run settles model_error).
	const opened = await openHarness(config, {
		identity,
		extensions: [{ name: "ext-faux", providers: [{ provider: faux.provider }] }],
		extensionSpecifiers: [LOOPBACK_SPECIFIER],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: join(dir, "config"),
	});
	const tokens: Record<string, string> = {};
	// An unclaimed directory has no users to mint for (the claimed-gate
	// e2e drives the loopback fixture directly — the HTTP surface would
	// 403 setup_required under any auth).
	if (!opts.unclaimed) {
		for (const user of ["tester", ...seedUsers.map((u) => u.user)]) {
			const { token } = await opened.identity.tokens.create(
				`${user}-cli`,
				user,
			);
			tokens[user] = token;
		}
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
		// Only the dir the boot OWNED is removed; a caller-supplied
		// storesDir survives (the restart e2e boots over it again).
		if (ownedDir) {
			await rm(dir, { recursive: true, force: true });
		}
	};	const waitFor = async (
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
