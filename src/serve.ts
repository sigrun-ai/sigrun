/**
 * The serve boot (Task 5): the deploy entry's composition, factored out of
 * `src/index.ts` so the CLI's `run` command can reuse it (boot
 * harness+server, get the bound port, shut down on demand) while
 * `src/index.ts` — and therefore `npm start` and the cluster container
 * command — keeps the exact same deployed behavior by calling
 * {@link serve} once with signal handlers attached. Every behavior the
 * deploy-entry test pins (the bootstrap, the listening line, the
 * SIGTERM/SIGINT shutdown, the fail-loud boot) lives here.
 *
 * `loadConfig(process.env)` → settings bootstrap → `openHarness` →
 * `createServer` → listen.
 *
 * The settings bootstrap (ruling 5 / spec §6.6): on first boot the
 * store writes ONLY what the environment set (the env-sourced `server`
 * fields plus `extensions`/`defaultModel` when env supplied them —
 * defaults are never persisted), and the FINAL config re-resolves env
 * over the (possibly just-written) file (`loadConfig(env, file)`) — env
 * always wins, the file fills only what env leaves unset.
 * `SIGRUN_CONFIG_DIR` stays env-only (it locates the file itself).
 *
 * Fail-loud is the contract (the task brief): any boot error rejects the
 * boot promise; callers print it and exit 1 — a wedged deploy must crash,
 * never serve a broken process.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import net from "node:net";
import type { ListenerInfo } from "@sigrun/shared/views";
import { envServerSection, loadConfig, parseExtensionList } from "./config.js";
import { openHarness } from "./harness/boot.js";
import { packagesDirOf, syncPackages } from "./harness/packages.js";
import { defaultSettingsDir, SettingsStore } from "./harness/settings.js";
import { startGateway } from "./server/gateway.js";
import { SIGRUN_VERSION } from "./server/schema-fixture.js";
import { createServer } from "./server/index.js";
import {
	createShutdown,
	PROVIDER_REFRESH_SHUTDOWN_CAP_MS,
	shutdownBudgetMs,
} from "./server/shutdown.js";

/**
 * Arm the admin-restart force-exit watchdog. The injected timer/exit seams
 * make the contract testable without exiting the suite's process. Returns
 * the disarm function used after a clean ordered shutdown.
 */
export function armRestartWatchdog(
	budgetMs: number,
	opts?: {
		setTimer?: (cb: () => void, ms: number) => { unref?(): void };
		exit?: (code: number) => void;
	},
): () => void {
	const setTimer: (cb: () => void, ms: number) => { unref?(): void } =
		opts?.setTimer ?? setTimeout;
	const exit = opts?.exit ?? process.exit;
	const watchdog = setTimer(() => {
		console.error(
			`sigrun: restart shutdown exceeded ${budgetMs}ms; forcing exit`,
		);
		exit(1);
	}, budgetMs);
	watchdog.unref?.();
	return () => clearTimeout(watchdog as ReturnType<typeof setTimeout>);
}

/** A booted harness+server pair: the bound port and the ordered shutdown. */
export interface BootedServer {
	/** The port the server actually bound (the resolved `SIGRUN_PORT`). */
	readonly port: number;
	/**
	 * The ordered shutdown (spec §2, memory-seam Task 4): close the server
	 * (drain in-flight requests), run the event bus's shutdown sequence
	 * (drain pending settles, then deliver `harnessShutdown` — handlers may
	 * commit, admission is still open), stop the interval refresh scheduler
	 * and join any still-in-flight boot refresh (provider plugins Tasks 4-5
	 * — no catalog fetch outlives the shutdown), THEN close the harness
	 * (joins tasks, seals storage). Throws with all collected failures;
	 * resolves on a clean close. Does NOT exit the process — the caller owns
	 * exit policy (the deploy entry exits 0/1; the CLI's `run` returns to its
	 * exit code).
	 */
	shutdown(): Promise<void>;
	/**
	 * Idempotent {@link BootedServer.shutdown} guarded against re-entry:
	 * the deploy entry's signal path calls this (a second SIGTERM/SIGINT
	 * must not re-enter — the second harness.close() throws upstream, and
	 * which invocation reached process.exit first would be a race).
	 * Concurrent callers join the ONE in-flight shutdown.
	 */
	shutdownOnce(): Promise<void>;
}

/**
 * The deploy entry's default listen host: the IPv6 wildcard, which is a
 * DUAL-STACK listener on Linux (`net.ipv6.bindv6only` is 0) — it accepts
 * the pod's IPv4 connections AND its IPv6 ones.
 *
 * `0.0.0.0` is the WRONG default for a dual-stack cluster: it is a
 * v4-only socket, so it refuses every IPv6 connection, while a Service
 * whose `ipFamilies` is `["IPv6"]` advertises only the pod's IPv6
 * address in its EndpointSlice. The gateway dials that address, gets
 * connection-refused, and answers the browser with "upstream connect
 * error or disconnect/reset before headers. reset reason: remote
 * connection failure". (This cluster's ClusterIP range is
 * `fd00:beef:cafe::/…`, so a chart-default Service is IPv6-only — the
 * mismatch is the DEFAULT shape, not an edge case.)
 */
export const DEFAULT_LISTEN_HOST = "::";

/**
 * Boot options. The one knob is the listen host: the default is the
 * container's dual-stack wildcard {@link DEFAULT_LISTEN_HOST} (a v4-only
 * bind would be unreachable on a dual-stack pod's IPv6 endpoint); the
 * CLI's `run` passes `127.0.0.1` — workstation mode is local-only (the
 * TUI dials loopback; the naive-identity API must not answer on the LAN).
 * `SIGRUN_LISTEN_HOST` (in the env passed to {@link serve}) is the
 * environment equivalent of `host` (serving spec §1).
 */
export interface ServeOptions {
	/**
	 * The listen host (wins over `SIGRUN_LISTEN_HOST`; both default to
	 * {@link DEFAULT_LISTEN_HOST}; `run` passes `"127.0.0.1"`).
	 */
	readonly host?: string;
}

export const LISTENER_PROBE_TIMEOUT_MS = 5_000;

/** Test-only seam for the post-listen failure boundary; production uses the real probe. */
export const listenerProbe = { connect: probeLoopback };

/**
 * One loopback probe: whether a TCP connection to `host:port` succeeds.
 * Bounded by {@link LISTENER_PROBE_TIMEOUT_MS}: a silently dropped
 * loopback connect resolves `false` (never hangs boot — an inconclusive
 * measurement must fail loudly, spec §2).
 */
function probeLoopback(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		const settle = (ok: boolean): void => {
			clearTimeout(timer);
			socket.destroy();
			resolve(ok);
		};
		const timer = setTimeout(() => settle(false), LISTENER_PROBE_TIMEOUT_MS);
		timer.unref();
		socket.once("connect", () => settle(true));
		socket.once("error", () => settle(false));
	});
}

/**
 * Measure the live listener's address families ONCE (release-readiness
 * Task 1, serving spec §2) and return the retained {@link ListenerInfo}.
 *
 * - A literal IPv4/IPv6 host reports its family without probing.
 * - A hostname bind reports the bound socket's family (`address()` —
 *   Node binds ONE resolved address for a hostname listen). A hostname
 *   or wildcard is never reported as a concrete peer address: the wire
 *   host stays the configured string.
 * - The `::` wildcard does NOT assume dual-stack from the spelling: one
 *   startup loopback probe against `127.0.0.1` and `[::1]` on the bound
 *   port, retaining exactly the families that connect. Absence of
 *   exactly one family is a legitimate result (an IPv6-only host).
 *   INCONCLUSIVE — neither loopback connects while the listener is bound
 *   — throws: serving fails loudly rather than advertising unmeasured
 *   reachability.
 *
 * @param host the effective host string supplied to `listen`.
 * @param address `app.server.address()` after listen (null → loud).
 * @param connect the probe (tests inject; production is
 *   {@link probeLoopback}).
 */
export async function measureListener(
	host: string,
	address: string | { address: string; family: string | number; port: number } | null,
	connect: (host: string, port: number) => Promise<boolean> = probeLoopback,
): Promise<ListenerInfo> {
	if (address === null || typeof address === "string") {
		throw new Error(
			"listener measurement failed: the server reports no bound address",
		);
	}
	const port = address.port;
	const literal = net.isIP(host);
	if (literal === 4) return { host, port, families: ["ipv4"] };
	if (literal === 6 && address.address !== "::") {
		return { host, port, families: ["ipv6"] };
	}
	if (literal === 0) {
		// A hostname bind: the bound socket's family, verbatim.
		const family =
			address.family === "IPv4" || address.family === 4 ? "ipv4" : "ipv6";
		return { host, port, families: [family] };
	}
	// The BOUND socket identifies the wildcard: Node canonicalizes alternate
	// spellings such as ::0 to ::. Measure, never infer dual-stack from the
	// configured spelling.
	const [v4, v6] = await Promise.all([
		connect("127.0.0.1", port),
		connect("::1", port),
	]);
	const families: ("ipv4" | "ipv6")[] = [];
	if (v4) families.push("ipv4");
	if (v6) families.push("ipv6");
	if (families.length === 0) {
		throw new Error(
			`listener reachability check inconclusive on ${host}:${port} — neither 127.0.0.1 nor [::1] connected while the listener is bound`,
		);
	}
	return { host, port, families };
}

/**
 * Boot the harness + server composition and listen on
 * `options.host ?? env.SIGRUN_LISTEN_HOST ?? "::"` + `<port>` (the
 * default is the container's
 * dual-stack wildcard — loopback-only would be unreachable behind the
 * Service, and a v4-only bind is unreachable on an IPv6 endpoint;
 * `loadConfig` refuses port 0, so a real port is always bound).
 * The CLI's `run` additionally launches the TUI against the loopback URL
 * on {@link BootedServer.port}.
 */
export async function serve(
	env: NodeJS.ProcessEnv,
	options?: ServeOptions,
): Promise<BootedServer> {
	// 1. Env-only resolution (the pre-file behavior — fail-loud on a bad
	//    env value before anything is written). A file-only `defaultModel`
	//    must NOT fail here: the file has not been read yet, and step 3
	//    re-resolves with it. The env-only `envConfig` result feeds ONLY the
	//    bootstrap's `defaultModel` write, which is used only when env
	//    actually supplied the model — so skip the env-only resolution
	//    entirely when no env model is set (a file-only model otherwise
	//    throws here, before `settings.json` is ever read).
	const envHasModel =
		env.SIGRUN_DEFAULT_MODEL?.trim() !== undefined ||
		env.SIGRUN_MODEL?.trim() !== undefined;
	const envConfig = envHasModel ? loadConfig(env) : undefined;
	// 2. First-boot bootstrap (ruling 5 / spec §6.6): absent settings file
	//    → write ONLY what the environment explicitly set — the env-sourced
	//    `server` fields (`envServerSection`) plus `extensions` and
	//    `defaultModel` when env supplied them. Defaults are NEVER
	//    persisted, so later releases' default changes reach existing
	//    installs (the file records intent, not reality); a `server`
	//    section with zero entries is omitted entirely. A present file is
	//    never touched.
	const envModel =
		env.SIGRUN_DEFAULT_MODEL?.trim() || env.SIGRUN_MODEL?.trim() || undefined;
	const settingsStore = new SettingsStore({ dir: defaultSettingsDir() });
	settingsStore.bootstrap(envServerSection(env), {
		extensions:
			env.SIGRUN_EXTENSIONS?.trim() === undefined
				? undefined
				: envConfig!.extensions,
		defaultModel:
			envModel === undefined
				? undefined
				: `${envConfig!.models.provider}/${envConfig!.models.modelId}`,
	});
	// 3. Final resolution: env over the file over code defaults. The file
	//    re-read picks up whatever bootstrap wrote (or what was already
	//    there) — env still wins every field it sets.
	const config = loadConfig(env, settingsStore.read());
	// Boot-time package install (the pi-style packages dir): the settings
	// file's top-level `packages` array is the INSTALL intent — install the
	// declared specifiers into `<config-dir>/packages` and prune the
	// undeclared BEFORE any extension loads. Fail-loud: an uninstallable
	// declaration fails the boot here, naming the specifier. Steady state
	// (the dir already matches) costs one manifest read, no subprocess.
	const packagesDir = packagesDirOf(defaultSettingsDir());
	// The MERGED extension spec list (env SIGRUN_EXTENSIONS over the file —
	// the same precedence loadConfig applied above), not the file's list
	// alone: an env-declared extension must install and load even when the
	// file declares none (e.g. a pre-existing settings file blocks the
	// bootstrap mirror). Merge at SPEC level: config.extensions is the
	// loader's flattened string[] view (entry/ref/enabled already
	// discarded); syncPackages needs the full ExtensionSpec objects, so the
	// env list or the file's verbatim entries feed it directly.
	const settingsFile = settingsStore.read();
	const extensionSpecs =
		parseExtensionList(env.SIGRUN_EXTENSIONS) ?? settingsFile.extensions ?? [];
	const extensionResolutions = await syncPackages(extensionSpecs, packagesDir);
	// The workspace directory must exist before any files endpoint or tool
	// call touches it. The deploy manifest mounts a volume at /data; the
	// workspace is /data/workspace. Without this, the first files request
	// 404s forever (the directory was never created).
	const { mkdir } = await import("node:fs/promises");
	await mkdir(config.workspace.path, { recursive: true });
	// The serve env threads into boot so boot-time env reads (store
	// roots, the provider collector, the U4 scheduler cadence resolution
	// in `resolveRefreshMinutes`) see the SAME env `loadConfig` just
	// resolved — a serve-harness env override must win over process.env
	// here exactly like it does in the config.
	// The ONE listener decision (release-readiness Task 1, serving spec §1):
	// `options.host` → `SIGRUN_LISTEN_HOST` (from the env `serve` received)
	// → `DEFAULT_LISTEN_HOST`, resolved ONCE here and handed verbatim to
	// `openHarness` (the boot-side auth derivation), `createServer` (the
	// pipeline's Host check + method list), and `app.listen` (the actual
	// bind) — the three consumers can never disagree.
	const host = options?.host ?? env.SIGRUN_LISTEN_HOST ?? DEFAULT_LISTEN_HOST;
	const opened = await openHarness(config, {
		extensionEntries: extensionResolutions,
		env,
		listenHost: host,
	});
	// The gateway handle (gateway C2) exists BEFORE the server: the meta
	// route reaches it through ServerContext, so the engine's health is
	// reportable from the first request. The ENGINE STARTS after listen
	// (below) — an engine supervising chat transports starts once the
	// server it delivers through is up.
	const gateway = startGateway(opened);
	// The booted handle the restart callback defers to: `createServer`
	// needs the callback BEFORE `serve` can build the BootedServer (the
	// shutdown composition lives at the bottom of this function), so the
	// handle is promised here and RESOLVED at return time; `onRestart`
	// awaits the resolution. Between `app.listen` + `gateway.started` and
	// the assignment below a supervised admin POST can already land (202
	// answered, callback deferred) — awaiting the promise holds that
	// window open instead of dropping the restart on the floor (a `?.`
	// on an unassigned ref made 202-with-no-restart reachable).
	let resolveBooted!: (booted: BootedServer) => void;
	const bootedReady = new Promise<BootedServer>((resolve) => {
		resolveBooted = resolve;
	});
	// The contributed-bundle registry (build-and-webui Task 6): boot folded
	// the loader's extension contributions into the name-keyed registry;
	// the server's serve-time NAME-selector resolution reads it here.
	const app = await createServer(opened, config, opened.webuiBundles, {
		listenHost: host,
		env,
		gateway,
		// U4 Task 2 (spec §13.3): the admin restart route's callback runs
		// EXACTLY the SIGTERM path (the ordered shutdown), then exits 0 —
		// the supervisor (chart/compose, `server.supervised`) brings the
		// process back. `shutdownOnce` is the same re-entry guard the
		// signal path uses; `stopping` is assigned by closure below, so
		// the callback defers to it (the route fires post-listen).
		onRestart: () =>
			bootedReady
				.then(async (handle) => {
					// A wedged stage must never leave the supervisor waiting for
					// a process that cannot die. The watchdog shares the ordered
					// shutdown's computed fixed budget; it is unref'd, so the
					// normal path (shutdown settles, exit below) is unaffected.
					const disarmWatchdog = armRestartWatchdog(shutdownBudgetMs(config.memorySeam));
					await handle.shutdownOnce();
					disarmWatchdog();
					process.exit(0);
				})
				.catch((error: unknown) => {
					console.error("sigrun restart error:", error);
					process.exit(1);
				}),
	});
	// The ordered shutdown exists before listen so a failed measurement can
	// run the SAME cleanup as an ordinary stop. In particular, a rejected
	// serve() must not leave the bound listener or harness keeping the
	// caller's process alive.
	const shutdown = createShutdown({
		endStreams: () => app.sse.endAll(),
		closeApp: () => app.close(),
		gateway,
		eventBusShutdown: () =>
			opened.eventBus.shutdownSequence(BACKGROUND_CONTEXT),
		stopSandboxWorkers: async () => {
			await opened.sandboxPool.stopAll();
			await opened.userServices.stopAll();
		},
		stopProviderRefresh: async () => {
			// The interval refresh scheduler (provider plugins Task 5) stops
			// BEFORE the harness closes. The T4 boot refresh promise is raced
			// against a bounded join: a wedged catalog fetch must not hold the
			// ordered shutdown (and the SSE test harness's `app.close`) — the
			// refresh contract already treats abandon as a retained-catalog
			// warn, never a boot failure.
			opened.stopProviderRefresh();
			let joined = false;
			const join = opened.bootRefresh
				.then(() => {
					joined = true;
				})
				.catch(() => {});
			const BOOT_REFRESH_JOIN_MS = PROVIDER_REFRESH_SHUTDOWN_CAP_MS;
			await Promise.race([
				join,
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, BOOT_REFRESH_JOIN_MS);
					timer.unref?.();
				}),
			]);
			if (!joined) {
				console.warn(
					`sigrun: boot refresh still in flight after ${BOOT_REFRESH_JOIN_MS}ms at shutdown — abandoning the join`,
				);
			}
		},
		closeHarness: () => opened.harness.close(BACKGROUND_CONTEXT),
	});

	await app.listen({ port: config.port, host });
	// Measure the live listener ONCE and retain the facts (spec §2): the
	// meta route projects this record; no probe ever runs per request. A
	// failed or inconclusive measurement closes the listener and harness,
	// then rethrows — serving fails loudly without stranding live resources.
	let listener: ListenerInfo;
	try {
		listener = await measureListener(host, app.server.address(), listenerProbe.connect);
	} catch (error) {
		try {
			await shutdown();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "sigrun boot and boot-failure cleanup failed");
		}
		throw error;
	}
	(app.sigrunContext.listener as { families: ListenerInfo["families"] })
		.families = listener.families;
	// The engine starts with the listener live (gateway C2's lifecycle:
	// start after listen — a failed start latches degraded inside the
	// handle, never wedges boot). AWAITED: serve() resolves only once the
	// engine start completed (or failed-and-latched) — the constraint's
	// intent; the lazy `started` never rejects, so this await cannot throw.
	await gateway.started;
	// Machine-greppable: the deploy-entry test waits for this line, and an
	// operator reading pod logs sees the bound port without guessing. The
	// version rides the same line (what an operator quotes in a bug report).
	// An IPv6 host is bracketed — the URL form (`http://[::]:3000`), not the
	// ambiguous `http://:::3000`.
	const shownHost = host.includes(":") ? `[${host}]` : host;
	console.log(
		`sigrun v${SIGRUN_VERSION} listening on http://${shownHost}:${config.port}`,
	);

	let stopping: Promise<void> | undefined;
	const booted: BootedServer = {
		port: config.port,
		shutdown,
		shutdownOnce: () => {
			stopping ??= shutdown();
			return stopping;
		},
	};
	resolveBooted(booted);
	return booted;
}
