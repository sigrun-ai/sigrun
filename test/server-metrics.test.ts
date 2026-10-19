/**
 * W2 Task 8: `GET /metrics` — the Prometheus text exposition (spec §6.9).
 *
 * Pinned here:
 * - the exposition contract: `text/plain; version=0.0.4; charset=utf-8`,
 *   every sample line parses as `name{labels} value`, and every metric
 *   family carries `# HELP` + `# TYPE … gauge` lines (label values escape
 *   per the exposition format);
 * - the in-process inventory: `sigrun_up 1` on a healthy harness,
 *   `sigrun_provider_ready{provider,status}` at the auth-check statuses
 *   (the same three-priority derivation `/v1/auth/check` serves);
 * - Review Focus 5, the shutdown race: a scrape after `harness.close()`
 *   still answers 200 with `sigrun_up 0` — `harness.inspect()` throws on
 *   a closed harness and the handler degrades instead of 500ing.
 *
 * Hermetic pattern (auth-hook.test.ts): faux provider + tmp workspace +
 * `app.inject()`. The faux contributor carries a readiness tracker so the
 * provider surface reports `ready` (a tracker-less contributor would
 * honestly report `not_ready`, which is not the line this suite pins).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import type { FastifyInstance } from "fastify";

/** One exposition sample line: `name` / `name{…}` then the value. */
const SAMPLE_LINE = /^[a-z_]+(\{[^}]*\})? -?[0-9.e+]+$/;

/** One hermetic server: harness + faux provider (tracker `ready`) + app. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot a hermetic server in a tmpdir; registers cleanup. */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-metrics-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [
			{
				provider: faux.provider,
				readiness: () => ({ status: "ready" }),
			},
		],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: {},
	});
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close().catch(() => {});
		await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened };
}

/** GET /metrics (200 asserted) as raw exposition text. */
async function getMetrics(app: FastifyInstance): Promise<string> {
	const response = await app.inject({ method: "GET", url: "/metrics" });
	expect(response.statusCode).toBe(200);
	return response.body;
}

/** Parse the exposition: every sample line matches, and every family
 * named by a sample carries both a HELP and a `gauge` TYPE line. Returns
 * the sample lines (comments stripped). */
function parseExposition(body: string): string[] {
	const lines = body.split("\n").filter((line) => line !== "");
	const helps = new Set<string>();
	const types = new Set<string>();
	for (const line of lines) {
		if (line.startsWith("# HELP ")) {
			helps.add(line.slice("# HELP ".length).split(" ")[0]!);
		} else if (line.startsWith("# TYPE ")) {
			const rest = line.slice("# TYPE ".length);
			const [name, kind] = rest.split(" ");
			expect(kind, `# TYPE of ${name}`).toBe("gauge");
			types.add(name!);
		}
	}
	const samples: string[] = [];
	for (const line of lines) {
		if (line.startsWith("#")) continue;
		expect(line, `sample line must parse: ${line}`).toMatch(SAMPLE_LINE);
		const name = line.split(" ")[0]!.split("{")[0]!;
		expect(helps.has(name), `${name} must carry a # HELP line`).toBe(true);
		expect(types.has(name), `${name} must carry a # TYPE gauge line`).toBe(
			true,
		);
		samples.push(line);
	}
	return samples;
}

describe("GET /metrics (W2 Task 8, spec §6.9)", () => {
	test("serves the exposition content type with a parsable body", async () => {
		const { app } = await bootServer();
		const response = await app.inject({ method: "GET", url: "/metrics" });
		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toBe(
			"text/plain; version=0.0.4; charset=utf-8",
		);
		expect(parseExposition(response.body).length).toBeGreaterThan(0);
	});

	test("a healthy harness reports sigrun_up 1 and per-provider readiness", async () => {
		const { app } = await bootServer();
		const body = await getMetrics(app);
		const samples = parseExposition(body);
		expect(samples).toContain("sigrun_up 1");
		expect(samples).toContain(
			'sigrun_provider_ready{provider="faux",status="ready"} 1',
		);
		// The wedge gauge always exists (0 when no run is live), the
		// scrape-rate task family is present on a healthy harness, and the
		// unconfigured backup deploys WITHOUT the marker family.
		expect(samples).toContain("sigrun_inflight_submission_oldest_seconds 0");
		expect(samples.some((line) => line.startsWith("sigrun_live_runs "))).toBe(
			true,
		);
		expect(
			samples.some((line) => line.startsWith("sigrun_tasks_live{")),
		).toBe(true);
		expect(
			samples.some((line) =>
				line.startsWith("sigrun_backup_last_success_timestamp_seconds"),
			),
		).toBe(false);
	});

	test("a scrape racing shutdown (harness closed) answers 200 with sigrun_up 0", async () => {
		const { app, opened } = await bootServer();
		await opened.harness.close(BACKGROUND_CONTEXT);
		const body = await getMetrics(app);
		// Review Focus 5: harness.inspect() throws after close — the handler
		// degrades to sigrun_up 0 instead of 500ing, and the body still
		// parses (the inspect-derived families are simply absent).
		const samples = parseExposition(body);
		expect(samples).toContain("sigrun_up 0");
		// The run-derived families are inspect-gated: on a closed harness
		// they vanish rather than reporting stale zeros (SigrunNotReady is
		// the down signal; a wedge gauge with no harness behind it would
		// lie). The boot-derived families keep serving.
		expect(
			samples.some((line) =>
				line.startsWith("sigrun_inflight_submission_oldest_seconds"),
			),
		).toBe(false);
		expect(
			samples.some((line) => line.startsWith("sigrun_live_runs ")),
		).toBe(false);
		expect(
			samples.some((line) => line.startsWith("sigrun_tasks_live")),
		).toBe(false);
		expect(
			samples.some((line) =>
				line.startsWith("sigrun_provider_ready{"),
			),
		).toBe(true);
	});
});
