import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { UserPolicy } from "../src/sandbox/policy.js";
import {
	decodeValue,
	encodeValue,
	errorReply,
	type JsonValue,
} from "../src/sandbox/protocol.js";
import {
	resolveWorkerEntry,
	testLauncher,
	WorkerPool,
	type WorkerClient,
	type WorkerEntry,
} from "../src/sandbox/pool.js";

describe("sandbox wire protocol", () => {
	test("encodes binary recursively and restores Uint8Array values", () => {
		const value = {
			plain: [null, true, 3, "text"],
			binary: new Uint8Array([0, 128, 255]),
		};
		const wire = encodeValue(value) as { binary: { $bytes: string } };
		expect(wire.binary).toEqual({ $bytes: Buffer.from([0, 128, 255]).toString("base64") });
		expect(decodeValue(wire)).toEqual(value);
	});

	test("round-trips typed file and execution errors with codes", async () => {
		const pool = new WorkerPool({
			launcher: () => { throw new Error("not launched"); },
			idleMinutes: () => 10,
			log: () => {},
			workerEntry: { command: "unused", args: [] },
		});
		const client = pool.client({ user: "errors", workspace: "/", home: "/", tmp: "/", ro: [], rw: [], ensureDirs: [], env: {} });
		const file = errorReply(1, new FileError("permission_denied", "denied", "/secret"));
		const exec = errorReply(2, new ExecutionError("timeout", "slow"));
		expect(file).toEqual({ id: 1, ok: false, error: { kind: "file", code: "permission_denied", message: "denied", path: "/secret" } });
		expect(exec).toEqual({ id: 2, ok: false, error: { kind: "exec", code: "timeout", message: "slow" } });
		await expect(client.decodeError(file)).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(FileError);
			expect((error as FileError).code).toBe("permission_denied");
			expect((error as FileError).path).toBe("/secret");
			return true;
		});
		await expect(client.decodeError(exec)).rejects.toBeInstanceOf(ExecutionError);
		client.close();
	});

	test("rejects malformed handle and byte sentinels", () => {
		expect(() => decodeValue({ $bytes: 4 } as unknown as JsonValue)).toThrow();
		expect(() => decodeValue({ $handle: "bad" } as unknown as JsonValue)).toThrow();
	});
});

describe("one worker execution path", { timeout: 30_000 }, () => {
	const context = BACKGROUND_CONTEXT;
	const cleanups: Array<() => Promise<void>> = [];
	let pool: WorkerPool | undefined;
	afterEach(async () => {
		await pool?.stopAll();
		pool = undefined;
		for (const cleanup of cleanups.splice(0)) await cleanup();
	});

	async function poolFor(entry: WorkerEntry): Promise<{ client: WorkerClient; workspace: string }> {
		const root = await mkdtemp(join(tmpdir(), "sigrun-sandbox-worker-"));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		await mkdir(join(root, "home"));
		await mkdir(join(root, "tmp"));
		const userPolicy: UserPolicy = {
			user: "one-path",
			workspace,
			home: join(root, "home"),
			tmp: join(root, "tmp"),
			ro: [],
			rw: [workspace],
			ensureDirs: [],
			// A marker with a deliberately hostile name proves nested exec
			// inherits the worker's scrubbed environment, not an empty one.
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: join(root, "home"),
				SIGRUN_SANDBOX_TEST_INHERIT: "worker-env",
			},
		};
		pool = new WorkerPool({
			launcher: testLauncher(entry),
			idleMinutes: () => 10,
			log: () => {},
			workerEntry: entry,
		});
		return { client: pool.client(userPolicy), workspace };
	}

	test("nested result exec inherits the worker environment with caller overrides winning", async () => {
		const { client, workspace } = await poolFor(resolveWorkerEntry(resolve(".")));
		let output = "";
		const observed = (await client.call("result", [
			"exec",
			[
				'printf "%s|%s" "$SIGRUN_SANDBOX_TEST_INHERIT" "$SIGRUN_SANDBOX_CALLER"',
				{ env: { SIGRUN_SANDBOX_CALLER: "caller-override" } },
			],
			workspace,
		], (event) => {
			if (event.event === "output") output += event.text;
		})) as { ok: true; value: { exitCode: number } };
		expect(observed.value.exitCode).toBe(0);
		// The worker's own scrubbed env (SIGRUN_SANDBOX_TEST_INHERIT=worker-env)
		// must reach the command through dispatchResult; an empty environment
		// there would print an empty first field. The caller's env overrides win.
		expect(output.trimEnd()).toBe("worker-env|caller-override");
	});

	test("nested result exec cancellation propagates", async () => {
		const { client, workspace } = await poolFor(resolveWorkerEntry(resolve(".")));
		const controller = new AbortController();
		const aborted = client.call(
			"result",
			["exec", ['trap "echo TERM_RECEIVED; exit 0" TERM; sleep 30', {}], workspace],
			undefined,
			withAbortSignal(controller.signal, context),
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		controller.abort();
		// The wire-level result path settles cancellation as an exec Result
		// (the worker reports the kill), not as an RPC rejection.
		const settled = (await aborted) as { ok: false; error: { kind: string; code: string } };
		expect(settled.ok).toBe(false);
		expect(settled.error.kind).toBe("exec");
		// The worker survives the abort and keeps serving.
		const next = (await client.call("result", [
			"exec",
			["printf alive", {}],
			workspace,
		])) as { ok: true; value: { exitCode: number; stdout: string } };
		expect(next.value.exitCode).toBe(0);
	});

	test("a top-level op exec request is rejected clearly by the REAL worker", async () => {
		// The real worker entry, driven with the deleted top-level op: the
		// rejection comes from dispatch's default arm, not from a fixture.
		const { client, workspace } = await poolFor(resolveWorkerEntry(resolve(".")));
		await expect(client.call("exec", ["printf hi", {}, workspace])).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(ExecutionError);
			expect((error as ExecutionError).message).toContain('top-level op "exec" is not supported');
			return true;
		});
		// The worker survives the rejection and keeps serving the live path.
		const next = (await client.call("result", [
			"exec",
			["printf alive", {}],
			workspace,
		])) as { ok: true; value: { exitCode: number } };
		expect(next.value.exitCode).toBe(0);
	});
});
