/** Self-service extension settings writes use the same publication seam as
 * section saves: one post-commit fence clear and one observing fan-out. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

const FIXTURE = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-me-settings-observer", "index.js"),
).href;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function boot(): Promise<{
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly token: string;
}> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-me-settings-publication-"));
	const env = {
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_AUTH: "token",
		SIGRUN_WEBUI: "false",
	};
	const identity = await seededIdentity(join(dir, "seed"));
	await identity.users.add({ user: "alice", admin: false, source: "cli" });
	const opened = await openHarness(loadConfig(env), {
		identity,
		env,
		builtins: false,
		extensionSpecifiers: [FIXTURE],
		isolationProbe: async () => ({ available: true, abi: 6 }),
	});
	const app = await createServer(opened, loadConfig(env));
	const token = (await opened.identity.tokens.create("alice-test", "alice")).token;
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, token };
}

async function fixture(): Promise<{
	received: { keys: string[]; user?: string; settings: Record<string, unknown> }[];
	reset(): void;
}> {
	return await import(FIXTURE) as never;
}

describe("PUT /v1/me/extensions/:slug/settings publication", () => {
	test("a committed write clears the fence and reconciles once, observing the new values and keys", async () => {
		const { app, opened, token } = await boot();
		const observer = await fixture();
		observer.reset();
		const fence = vi.spyOn(opened.userServices, "settingsChanged");
		const events: unknown[] = [];
		const unsubscribe = opened.events.subscribe((event) => {
			if ((event as { type?: string }).type === "settings.changed") events.push(event);
		});
		try {
			for (const settings of [
				{ theme: "dark", retries: 2 },
				{ theme: "dark", retries: 2 },
			]) {
				const response = await app.inject({
					method: "PUT",
					url: "/v1/me/extensions/acme-settings-observer/settings",
					headers: { authorization: `Bearer ${token}` },
					payload: settings,
				});
				expect(response.statusCode).toBe(200);
			}
			expect(fence).toHaveBeenCalledTimes(2);
			expect(fence).toHaveBeenNthCalledWith(1, "acme-settings-observer", "alice");
			expect(observer.received).toEqual([
				{ keys: ["theme", "retries"], user: "alice", settings: { theme: "dark", retries: 2 } },
				{ keys: ["theme", "retries"], user: "alice", settings: { theme: "dark", retries: 2 } },
			]);
			expect(events).toEqual([
				{ type: "settings.changed", scope: { extension: "acme-settings-observer" }, keys: ["theme", "retries"] },
				{ type: "settings.changed", scope: { extension: "acme-settings-observer" }, keys: ["theme", "retries"] },
			]);
		} finally {
			unsubscribe();
		}
	});

	test("invalid and unknown writes publish nothing", async () => {
		const { app, opened, token } = await boot();
		const observer = await fixture();
		observer.reset();
		const fence = vi.spyOn(opened.userServices, "settingsChanged");
		const events: unknown[] = [];
		const unsubscribe = opened.events.subscribe((event) => {
			if ((event as { type?: string }).type === "settings.changed") events.push(event);
		});
		try {
			for (const [url, payload] of [
				["/v1/me/extensions/acme-settings-observer/settings", []],
				["/v1/me/extensions/acme-settings-observer/settings", null],
				["/v1/me/extensions/unknown/settings", { theme: "dark" }],
			] as const) {
				const response = await app.inject({
					method: "PUT",
					url,
					headers: { authorization: `Bearer ${token}` },
					payload: payload as Record<string, unknown>,
				});
				expect(response.statusCode).toBeGreaterThanOrEqual(400);
			}
			expect(fence).not.toHaveBeenCalled();
			expect(observer.received).toEqual([]);
			expect(events).toEqual([]);
		} finally {
			unsubscribe();
		}
	});
});
