/**
 * Multi-user M1 Task 2: native-helper resolution and the boot-time
 * availability decision. Kernel/helper behavior is injected for the reason
 * matrix; the real binary, when this checkout has built it, is probed as-is.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
import { resolveHelper } from "../src/sandbox/helper.js";
import {
	probeIsolation,
	runHelperProbe,
	selfTestHelper,
} from "../src/sandbox/availability.js";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-sandbox-availability-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function probeOptions(init: {
	platform?: NodeJS.Platform;
	helper?: string | undefined;
	abi?: number;
	selfTest?: boolean;
}) {
	return {
		platform: init.platform ?? ("linux" as NodeJS.Platform),
		helper: "helper" in init ? init.helper : "/opt/sigrun-sandbox",
		runProbe: vi.fn(async (_helper: string) => ({ abi: init.abi ?? 6 })),
		selfTest: vi.fn(async (_helper: string) => init.selfTest ?? true),
	};
}

describe("probeIsolation", () => {
	test("reports not linux without invoking either helper command", async () => {
		const options = probeOptions({ platform: "darwin" });
		await expect(probeIsolation(options)).resolves.toEqual({
			available: false,
			abi: 0,
			reason: "not linux",
		});
		expect(options.runProbe).not.toHaveBeenCalled();
		expect(options.selfTest).not.toHaveBeenCalled();
	});

	test("reports sandbox helper not found without invoking either command", async () => {
		const options = probeOptions({ helper: undefined });
		await expect(probeIsolation(options)).resolves.toEqual({
			available: false,
			abi: 0,
			reason: "sandbox helper not found",
		});
		expect(options.runProbe).not.toHaveBeenCalled();
		expect(options.selfTest).not.toHaveBeenCalled();
	});

	test("reports the actual ABI when it is below 6 and skips the self-test", async () => {
		const options = probeOptions({ abi: 3 });
		await expect(probeIsolation(options)).resolves.toEqual({
			available: false,
			abi: 3,
			reason: "landlock ABI 3 < 6",
		});
		expect(options.runProbe).toHaveBeenCalledOnce();
		expect(options.runProbe).toHaveBeenCalledWith("/opt/sigrun-sandbox");
		expect(options.selfTest).not.toHaveBeenCalled();
	});

	test("reports self-test failed after an ABI-capable helper", async () => {
		const options = probeOptions({ abi: 6, selfTest: false });
		await expect(probeIsolation(options)).resolves.toEqual({
			available: false,
			abi: 6,
			reason: "self-test failed",
		});
		expect(options.selfTest).toHaveBeenCalledOnce();
		expect(options.selfTest).toHaveBeenCalledWith("/opt/sigrun-sandbox");
	});

	test("ABI 6 and a passing self-test is available and retains the helper", async () => {
		const options = probeOptions({ abi: 6, selfTest: true });
		await expect(probeIsolation(options)).resolves.toEqual({
			available: true,
			abi: 6,
			helper: "/opt/sigrun-sandbox",
		});
		expect(options.runProbe).toHaveBeenCalledOnce();
		expect(options.selfTest).toHaveBeenCalledOnce();
	});
});

describe("resolveHelper", () => {
	test("an existing absolute SIGRUN_SANDBOX_HELPER wins over the repo build", async () => {
		const coreRoot = await tempDir();
		const envHelper = join(coreRoot, "chosen-helper");
		await writeFile(envHelper, "");
		const repoHelper = join(coreRoot, "sandbox/target/release/sigrun-sandbox");
		await mkdir(dirname(repoHelper), { recursive: true });
		await writeFile(repoHelper, "");
		expect(resolveHelper({ SIGRUN_SANDBOX_HELPER: envHelper }, coreRoot)).toBe(
			envHelper,
		);
	});

	test("a set-but-missing env helper warns once and falls through to the repo build", async () => {
		const coreRoot = await tempDir();
		const repoHelper = join(coreRoot, "sandbox/target/release/sigrun-sandbox");
		await mkdir(dirname(repoHelper), { recursive: true });
		await writeFile(repoHelper, "");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			expect(
				resolveHelper(
					{ SIGRUN_SANDBOX_HELPER: join(coreRoot, "missing-helper") },
					coreRoot,
				),
			).toBe(repoHelper);
			expect(warn).toHaveBeenCalledOnce();
			expect(String(warn.mock.calls[0]?.[0])).toContain(
				"SIGRUN_SANDBOX_HELPER",
			);
		} finally {
			warn.mockRestore();
		}
	});

	test("an installed platform package wins over the repo build", async () => {
		const coreRoot = await tempDir();
		const packageHelper = join(
			coreRoot,
			`node_modules/@sigrun/sandbox-linux-${process.arch}/bin/sigrun-sandbox`,
		);
		await mkdir(dirname(packageHelper), { recursive: true });
		await writeFile(packageHelper, "");
		const repoHelper = join(coreRoot, "sandbox/target/release/sigrun-sandbox");
		await mkdir(dirname(repoHelper), { recursive: true });
		await writeFile(repoHelper, "");
		expect(resolveHelper({}, coreRoot)).toBe(packageHelper);
	});

	test("the repo release build is the final candidate and absence returns undefined", async () => {
		const coreRoot = await tempDir();
		expect(resolveHelper({}, coreRoot)).toBeUndefined();
		const repoHelper = join(coreRoot, "sandbox/target/release/sigrun-sandbox");
		await mkdir(dirname(repoHelper), { recursive: true });
		await writeFile(repoHelper, "");
		expect(resolveHelper({}, coreRoot)).toBe(repoHelper);
	});
});

describe("selfTestHelper control and denial classification", () => {
	async function fakeHelper(script: string): Promise<string> {
		const dir = await tempDir();
		const helper = join(dir, "fake-sigrun-sandbox");
		await writeFile(helper, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
		return helper;
	}

	/** Shell prelude exposing the reader argv and probe-directory grant. */
	const detectGrant = `
reader=$2
probe=$3
probeDir=$(dirname "$probe")
case "$SIGRUN_SANDBOX_POLICY" in
	*"$probeDir"*) granted=1 ;;
	*) granted=0 ;;
esac`;

	test("helper refusal exit 125 with its diagnostic is not a denial", async () => {
		const helper = await fakeHelper(
			"echo 'sigrun-sandbox: invalid policy' >&2\nexit 125",
		);
		await expect(selfTestHelper(helper)).resolves.toBe(false);
	});

	test("a non-zero exit without running the command is not a denial", async () => {
		const helper = await fakeHelper("exit 1");
		await expect(selfTestHelper(helper)).resolves.toBe(false);
	});

	test("a spawn failure is not a denial", async () => {
		const dir = await tempDir();
		await expect(
			selfTestHelper(join(dir, "nonexistent-helper")),
		).resolves.toBe(false);
	});

	test("a successful unconfined read is not a denial", async () => {
		const helper = await fakeHelper("shift 2\nexec \"$@\"");
		await expect(selfTestHelper(helper)).resolves.toBe(false);
	});

	test("a missing jailed command is not a denial", async () => {
		const helper = await fakeHelper(
			"echo 'sigrun-sandbox: cannot exec /bin/sh: No such file or directory' >&2\nexit 125",
		);
		await expect(selfTestHelper(helper)).resolves.toBe(false);
	});

	test("a control failure from broken reader machinery is not a denial", async () => {
		const helper = await fakeHelper(
			"shift 2\necho 'node: reader startup failed' >&2\nexit 1",
		);
		await expect(selfTestHelper(helper)).resolves.toBe(false);
	});

	test("an exec denial without BEGIN is not a probe-read denial", async () => {
		const helper = await fakeHelper(
			`set -eu
shift 2
${detectGrant}
if [ "$granted" = 1 ]; then
	exec "$@"
fi
exit 126`,
		);
		await expect(selfTestHelper(helper)).resolves.toBe(false);
	});

	test("a denial-leg not-found failure after a valid control is not a denial", async () => {
		const helper = await fakeHelper(
			`set -eu
shift 2
${detectGrant}
if [ "$granted" = 1 ]; then
	exec "$@"
fi
printf 'BEGIN\\nREAD_DENIED:ENOENT\\n'
exit 1`,
		);
		await expect(selfTestHelper(helper)).resolves.toBe(false);
	});

	test("a non-EACCES reader failure after a valid control is not a denial", async () => {
		const helper = await fakeHelper(
			`set -eu
shift 2
${detectGrant}
if [ "$granted" = 1 ]; then
	exec "$@"
fi
printf 'BEGIN\\nREAD_DENIED:EIO\\n'
exit 1`,
		);
		await expect(selfTestHelper(helper)).resolves.toBe(false);
	});

	test("permission text in the probe path does not prove an EACCES denial", async () => {
		const helper = await fakeHelper(
			`set -eu
shift 2
${detectGrant}
if [ "$granted" = 1 ]; then
	exec "$@"
fi
printf 'BEGIN\\nREAD_DENIED:EIO\\n'
echo "reader: /tmp/Permission denied/example/probe: Input/output error" >&2
exit 1`,
		);
		await expect(selfTestHelper(helper)).resolves.toBe(false);
	});

	test("a valid control and permission-style denial passes", async () => {
		const helper = await fakeHelper(
			`set -eu
shift 2
${detectGrant}
[ -f "$reader" ] && [ -f "$probe" ]
if [ "$granted" = 0 ]; then
	# Simulate the policy boundary only on the denial leg.
	chmod 000 "$probe"
fi
exec "$@"`,
		);
		await expect(selfTestHelper(helper)).resolves.toBe(true);
	});
});

describe("real Task 1 helper", () => {
	const coreRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	const helper = join(coreRoot, "sandbox/target/release/sigrun-sandbox");
	test.runIf(existsSync(helper))(
		"probe parses its real ABI and availability reports the real kernel outcome",
		async () => {
			const abi = JSON.parse(
				execFileSync(helper, ["probe"], { encoding: "utf8" }),
			) as { abi: number };
			expect(Number.isInteger(abi.abi)).toBe(true);
			const availability = await probeIsolation({
				platform: process.platform,
				helper: resolveHelper({}, coreRoot),
				runProbe: runHelperProbe,
				selfTest: selfTestHelper,
			});
			expect(availability.abi).toBe(abi.abi);
			if (abi.abi < 6) {
				expect(availability).toEqual({
					available: false,
					abi: abi.abi,
					reason: `landlock ABI ${abi.abi} < 6`,
				});
			} else {
				expect(availability).toEqual({
					available: true,
					abi: abi.abi,
					helper,
				});
			}
		},
	);
});

describe("boot and /v1/meta isolation reporting", () => {
	test("probes exactly once per boot and reports the injected darwin outcome", async () => {
		const dir = await tempDir();
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_AUTH: "none",
		});
		const isolationProbe = vi.fn<typeof probeIsolation>(async (options) =>
			probeIsolation({ ...options, platform: "darwin" }),
		);
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const opened = await openHarness(config, {
			env: {},
			identity: await seededIdentity(dir),
			builtins: false,
			isolationProbe,
		});
		const app = await createServer(opened, {
			...config,
			webui: { ...config.webui, enabled: false },
		});
		try {
			const readMeta = async () =>
				(app.inject({ method: "GET", url: "/v1/meta" })).then(
					(response) => response.json(),
				);
			const expected = {
				mode: "auto",
				active: false,
				available: false,
				abi: 0,
				reason: "not linux",
				osUsers: "off",
			};
			expect((await readMeta()).isolation).toEqual(expected);
			expect((await readMeta()).isolation).toEqual(expected);
			expect(isolationProbe).toHaveBeenCalledOnce();
			expect(
				log.mock.calls.filter((call) =>
					String(call[0]).startsWith("sandbox isolation:"),
				),
			).toHaveLength(1);
			expect(opened.isolation).toEqual({
				available: false,
				abi: 0,
				reason: "not linux",
			});
		} finally {
			log.mockRestore();
			await app.close();
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	});

	test("an enabled osUsers setting reports an unavailable probe reason", async () => {
		const dir = await tempDir();
		const config = loadConfig(
			{
				SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
				SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
				SIGRUN_WORKSPACE_PATH: dir,
				SIGRUN_AUTH: "none",
			},
			{ server: { isolation: { osUsers: true } } },
		);
		const opened = await openHarness(config, {
			env: {},
			identity: await seededIdentity(dir),
			builtins: false,
			isolationProbe: async () => ({ available: false, abi: 0, reason: "not linux" }),
		});
		const app = await createServer(opened, {
			...config,
			webui: { ...config.webui, enabled: false },
		});
		try {
			const meta = (await app.inject({ method: "GET", url: "/v1/meta" })).json();
			expect(meta.isolation.osUsers).toBe("osUsers requires CAP_SETUID");
		} finally {
			await app.close();
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	});

	test("a successful OS-user probe reports available", async () => {
		const dir = await tempDir();
		const config = loadConfig(
			{
				SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
				SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
				SIGRUN_WORKSPACE_PATH: dir,
				SIGRUN_AUTH: "none",
			},
			{ server: { isolation: { osUsers: true } } },
		);
		const opened = await openHarness(config, {
			env: {},
			identity: await seededIdentity(dir),
			builtins: false,
			isolationProbe: async () => ({ available: true, abi: 6 }),
			osUsersProbe: async () => ({ available: true, status: "available" }),
		});
		const app = await createServer(opened, {
			...config,
			webui: { ...config.webui, enabled: false },
		});
		try {
			const meta = (await app.inject({ method: "GET", url: "/v1/meta" })).json();
			expect(meta.isolation.osUsers).toBe("available");
		} finally {
			await app.close();
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	});
});
