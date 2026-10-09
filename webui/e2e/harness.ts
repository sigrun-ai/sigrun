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
}

/** Boot a hermetic E2E server on an ephemeral loopback port. */
export async function bootE2EServer(
	options: E2EServerOptions = {},
): Promise<E2EServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-e2e-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [
			{ id: "m", contextWindow: 128_000 },
			{ id: "m2", contextWindow: 64_000 },
		],
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
	});
	const app = await createServer(opened, config);
	let cleaned = false;
	const cleanup = async () => {
		if (cleaned) return;
		cleaned = true;
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	try {
		await app.listen({ port: 0, host: "127.0.0.1" });
	} catch (cause) {
		await cleanup();
		throw cause;
	}
	const address = app.server.address();
	if (address === null || typeof address === "string") {
		await cleanup();
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
		cleanup,
	};
}
