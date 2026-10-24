import { describe, expect, test } from "vitest";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import {
	decodeValue,
	encodeValue,
	errorReply,
	type JsonValue,
} from "../src/sandbox/protocol.js";
import { WorkerPool } from "../src/sandbox/pool.js";

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
		const client = pool.client({ user: "errors", workspace: "/", home: "/", tmp: "/", ro: [], rw: [], env: {} });
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
