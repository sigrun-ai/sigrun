/**
 * Core bridge fail-fast (spec §5.2, polish A1): the explicit
 * `expectHostBridge` contract. A bridge-backed `host.*` member call in a
 * process that will NEVER run `createServer` rejects immediately with
 * `HostBridgeUnavailableError` (naming the member and the calling
 * extension) instead of waiting out the 60s bind deadline. When a server
 * IS expected — the `expectHostBridge: true` open option, or
 * `createServer`'s synchronous on-entry `opened.expectHostBridge()` — the
 * pre-bind window keeps today's wait-and-bind semantics. The event-bus
 * `#bounded` failure path logs the unavailable error ONCE per
 * (extension, member) and swallows repeats.
 *
 * Hermetic pattern (memory-seam.test.ts): faux provider + tmpdir +
 * `openHarness` — real `node:sqlite` storage, no network. The fixture
 * extension calls `host.users.list()` from its `runSettled` handler.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SigrunConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { HostBridgeUnavailableError } from "../src/harness/seam-host.js";
import { createServer } from "../src/server/index.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";

/** The bridge-caller fixture entry, imported by specifier (factory + runSettled). */
const BRIDGE_CALLER_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-bridge-caller", "index.js"),
).href;

const FIXTURE_NAME = "sigrun-fixture-bridge-caller";

/** The fixture module's exports (outcome record + reset). */
type FixtureModule = {
	readonly outcomes: string[];
	readonly resetOutcomes: () => void;
};

async function fixtureModule(): Promise<FixtureModule> {
	return (await import(BRIDGE_CALLER_SPECIFIER)) as unknown as FixtureModule;
}

const dirs: string[] = [];
const closes: Array<() => Promise<void>> = [];

afterAll(async () => {
	for (const close of closes.splice(0)) await close();
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

interface Boot {
	opened: OpenedHarness;
	config: SigrunConfig;
	fixture: FixtureModule;
}

/** Boot one hermetic, serverless harness with the bridge-caller fixture installed. */
async function bootFixture(options: {
	responses?: readonly AssistantMessage[];
	expectHostBridge?: boolean;
} = {}): Promise<Boot> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-bridge-failfast-"));
	dirs.push(dir);
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([...(options.responses ?? [])]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	// Auto-naming off (the memory-seam convention): the namer would consume
	// scripted responses after the first settled run.
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const opened = await openHarness(config, {
		extensions: [contributor],
		// Hermetic: the built-ins' unscripted prompt sections and their own
		// bridged handlers are not this suite's subject.
		builtins: false,
		env: {},
		extensionSpecifiers: [BRIDGE_CALLER_SPECIFIER],
		settingsDir: dir,
		expectHostBridge: options.expectHostBridge,
	});
	closes.push(() => opened.harness.close(BACKGROUND_CONTEXT));
	const fixture = await fixtureModule();
	fixture.resetOutcomes();
	return { opened, config, fixture };
}

/** Submit one input on a fresh root and wait for the run to settle. */
async function runTurn(opened: OpenedHarness, input: string) {
	const root = await opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: opened.defaultModel },
	});
	const submission = await root.submit(
		{ type: "input", content: input },
		BACKGROUND_CONTEXT,
	);
	const record = await submission.wait(BACKGROUND_CONTEXT);
	expect(record.status).toBe("done");
	return root;
}

test("bridge call with no server expected rejects immediately", async () => {
	const { opened } = await bootFixture();
	const host = opened.seamHosts.get(FIXTURE_NAME);
	expect(host).toBeDefined();
	const started = Date.now();
	const pending = host!.users.list();
	const assertion = expect(pending).rejects.toThrow(HostBridgeUnavailableError);
	await assertion;
	expect(Date.now() - started).toBeLessThan(100);
	const error = await host!.users.list().catch((one: unknown) => one);
	expect(error).toBeInstanceOf(HostBridgeUnavailableError);
	expect((error as HostBridgeUnavailableError).member).toBe("users.list");
	expect((error as HostBridgeUnavailableError).caller).toBe(FIXTURE_NAME);
});

test("pre-bind call waits when a server is expected", async () => {
	const { opened, config } = await bootFixture({
		expectHostBridge: true,
	});
	const host = opened.seamHosts.get(FIXTURE_NAME)!;
	// Started BEFORE any server exists: under the old fail-fast shape this
	// would reject at once; the expectation makes it wait for the bind.
	const pending = host.users.list();
	const app = await createServer(opened, config);
	closes.push(() => app.close());
	await expect(pending).resolves.toBeDefined();
});

test("createServer marks the bridge expected", async () => {
	const { opened, config } = await bootFixture();
	const app = await createServer(opened, config);
	closes.push(() => app.close());
	const host = opened.seamHosts.get(FIXTURE_NAME)!;
	await expect(host.users.list()).resolves.toBeDefined();
});

test("unavailable bridge errors log once per extension and member", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const { opened, fixture } = await bootFixture({
			responses: [
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("second answer"),
			],
		});
		await runTurn(opened, "first input");
		await runTurn(opened, "second input");
		// Both settles delivered the handler; both bridged calls rejected.
		await vi.waitFor(() => expect(fixture.outcomes).toHaveLength(2), {
			timeout: 5_000,
			interval: 50,
		});
		expect(fixture.outcomes).toEqual([
			"HostBridgeUnavailableError",
			"HostBridgeUnavailableError",
		]);
		const naming = warn.mock.calls.filter((call) =>
			call.some(
				(arg) =>
					typeof arg === "string" &&
					arg.includes(FIXTURE_NAME) &&
					arg.includes("users.list"),
			),
		);
		expect(naming).toHaveLength(1);
	} finally {
		warn.mockRestore();
	}
});
