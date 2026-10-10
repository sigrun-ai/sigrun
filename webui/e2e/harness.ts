/**
 * Task 26b: the ship-gate E2E server fixture.
 *
 * Boots the REAL M1 server — `loadConfig` → `openHarness` → `createServer` →
 * `app.listen` on an ephemeral loopback port (the sse-view.test.ts listen
 * pattern, adapted from server.test.ts's hermetic bootServer) — with:
 *
 * - a multi-model faux provider (`faux/m` + `faux/m2`, so the composer's
 *   model picker has real options to exercise),
 * - storage + workspace in a per-boot tmpdir (hermetic, cleaned up),
 * - the webui bundle path pointed at the BUILT webui/dist, marked explicit
 *   so a missing bundle fails the boot loud instead of silently degrading
 *   to API-only (the `test:e2e` script builds the bundle first).
 *
 * The faux provider's scripted responses are configurable per boot via
 * `options.responses`; the default is a single canned assistant reply.
 *
 * Unlike the vitest suites, Playwright owns no cleanup registry here — the
 * returned `cleanup()` is explicit and idempotent; callers run it in
 * `afterAll`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import type { HarnessSettings } from "@earendil-works/pi-durable";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config.js";
import { openHarness, type OpenedHarness } from "../../src/harness/boot.js";
import type { ProviderContributor } from "../../src/harness/providers/index.js";
import { createServer } from "../../src/server/index.js";

/** The built bundle this E2E server serves (webui/e2e → webui/dist). */
const WEBUI_DIST = fileURLToPath(new URL("../dist", import.meta.url));

export interface E2EServerOptions {
	/**
	 * The faux provider's scripted responses (consumed one per generation).
	 * Defaults to a single canned assistant message; checklist tests pass
	 * their own scripts (tool calls, errors, deferred handles).
	 */
	readonly responses?: readonly FauxResponseStep[];
	/**
	 * T26b-iii item 3: the faux provider's stream pacing. A low
	 * `tokensPerSecond` keeps a turn busy long enough for the steer
	 * observation (the server-submissions.test.ts pattern).
	 */
	readonly tokensPerSecond?: number;
	/**
	 * T26b-iii item 7: harness settings (the `OpenHarnessOptions.settings`
	 * seam) — the forced compaction policy, per the mid-compaction driver.
	 */
	readonly settings?: HarnessSettings;
	/**
	 * T26b-iii items 4 + 7: extension package specifiers to load (the
	 * `OpenHarnessOptions.extensionSpecifiers` seam — "sigrun-ext-approvals",
	 * "sigrun-ext-memory-markdown"). Defaults to the parsed config's list (empty in
	 * this hermetic boot).
	 */
	readonly extensionSpecifiers?: readonly string[];
}

export interface E2EServer {
	/** The loopback base URL the server listens on (no trailing slash). */
	readonly url: string;
	/** The root conversation's id (the default session the sidebar lists). */
	readonly conversationId: number;
	/** The booted harness (conversations, docs, submission seams). */
	readonly opened: OpenedHarness;
	/** The listening Fastify app. */
	readonly app: FastifyInstance;
	/** The per-boot tmpdir — the conversation's workspace root (the checklist
	 * tests write files here for the workspace-browser + upload items). */
	readonly workspaceDir: string;
	/** Idempotent teardown: close the app, the harness, remove the tmpdir. */
	readonly cleanup: () => Promise<void>;
	/**
	 * T26b-iii item 10 (restart resume): close this server and re-boot on the
	 * SAME tmpdir + storage file (the transcript survives; the reserved root
	 * conversation resumes with the same id). The re-booted server listens on
	 * a NEW ephemeral port (navigate to its `url`) and takes over tmpdir
	 * cleanup ownership — this server is dead afterwards and its `cleanup`
	 * no-ops on the (still-alive) dir. Options merge over the original boot's
	 * (pass fresh `responses` for post-restart turns — the faux queue is a
	 * per-boot provider, re-created on every boot).
	 */
	readonly restart: (options?: E2EServerOptions) => Promise<E2EServer>;
}

/** Boot a hermetic E2E server on an ephemeral loopback port. */
export async function bootE2EServer(
	options: E2EServerOptions = {},
): Promise<E2EServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-e2e-"));
	return await bootOnDir(dir, options);
}

/**
 * Boot the E2E server onto `dir` (fresh or existing — an existing dir is the
 * restart-resume leg: storage + workspace persist across boots).
 */
async function bootOnDir(
	dir: string,
	options: E2EServerOptions,
): Promise<E2EServer> {
	const faux = fauxProvider({
		provider: "faux",
		models: [
			{ id: "m", contextWindow: 128_000 },
			{ id: "m2", contextWindow: 64_000 },
		],
		...(options.tokensPerSecond === undefined
			? {}
			: { tokensPerSecond: options.tokensPerSecond }),
	});
	faux.setResponses([
		...(options.responses ?? [fauxAssistantMessage("e2e answer")]),
	]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = {
		...loadConfig({
			SIGRUN_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
		}),
		webuiBundle: WEBUI_DIST,
		webuiBundleExplicit: true,
	};
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: {},
		...(options.extensionSpecifiers === undefined
			? {}
			: { extensionSpecifiers: options.extensionSpecifiers }),
		...(options.settings === undefined
			? {}
			: { settings: options.settings }),
	});
	const app = await createServer(opened, config);
	let closed = false;
	let ownsDir = true;
	// Close the listener + harness WITHOUT removing the tmpdir (the restart
	// leg leaves the storage in place for the next boot).
	const close = async () => {
		if (closed) return;
		closed = true;
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
	};
	try {
		await app.listen({ port: 0, host: "127.0.0.1" });
	} catch (cause) {
		await close();
		await rm(dir, { recursive: true, force: true });
		throw cause;
	}
	const address = app.server.address();
	if (address === null || typeof address === "string") {
		await close();
		await rm(dir, { recursive: true, force: true });
		throw new Error("e2e harness: app.listen returned no address");
	}
	const root = await opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: opened.defaultModel },
	});
	return {
		url: `http://127.0.0.1:${address.port}`,
		conversationId: root.id,
		opened,
		app,
		workspaceDir: dir,
		cleanup: async () => {
			await close();
			if (!ownsDir) return;
			ownsDir = false;
			await rm(dir, { recursive: true, force: true });
		},
		restart: async (restartOptions: E2EServerOptions = {}) => {
			await close();
			// The re-booted server owns the dir from here.
			ownsDir = false;
			return await bootOnDir(dir, { ...options, ...restartOptions });
		},
	};
}
