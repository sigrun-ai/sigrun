/** Child entry: serve pi-durable's own environment over stdin/stdout. */

import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import {
	type BinaryReader,
	type DirReader,
	type TextLineReader,
	type WatchChange,
	type WatchTarget,
	type ListFilesOptions,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createCommandObserver, type CommandObserver } from "./command-observer.js";
import {
	decodeValue,
	encodeMessage,
	encodeValue,
	errorReply,
	wireError,
	type JsonValue,
	type Reply,
	type Request,
} from "./protocol.js";

type Handle =
	| { kind: "text"; value: TextLineReader }
	| { kind: "binary"; value: BinaryReader }
	| { kind: "dir"; value: DirReader }
	| { kind: "watch"; value: { mode: "native" | "polling"; close(context: Context): Promise<void> } };

const environments = new Map<string, NodeExecutionEnv>();
/** Exec requests that have not reached pi-durable's synchronous spawn yet. */
const pendingSpawns = new Map<NodeExecutionEnv, Set<number>>();
/** One ownership observer per environment, shared by all its execs. */
const commandObservers = new Map<NodeExecutionEnv, CommandObserver>();
const handles = new Map<number, Handle>();
const active = new Map<number, AbortController>();
let nextHandle = 1;
let buffer = "";

function environment(cwd: string): NodeExecutionEnv {
	let env = environments.get(cwd);
	if (env === undefined) {
		env = new NodeExecutionEnv({ cwd });
		observeCommands(env);
		environments.set(cwd, env);
	}
	return env;
}

/**
 * Install ONE permanent observer per environment. This deliberately depends
 * on pi-durable 1.3.0's PRIVATE, UNDOCUMENTED activeChildPids field because
 * ExecutionEnv exposes no spawn notification. An upgrade that removes or
 * changes that field must update this observer; fail loudly rather than
 * silently losing crash cleanup.
 */
function observeCommands(env: NodeExecutionEnv): void {
	// SAFETY: this is the intentional private-field dependency described above.
	const registry = (env as unknown as { activeChildPids: Set<number> }).activeChildPids;
	if (!(registry instanceof Set)) {
		throw new Error("pi-durable activeChildPids is unavailable; sandbox command cleanup cannot be tracked");
	}
	commandObservers.set(env, createCommandObserver({
		registry,
		pending: () => pendingSpawns.get(env) ?? new Set(),
		active: () => new Set(active.keys()),
		emit: ({ id, pid, phase }) => write({ id, event: "command", pid, phase }),
	}));
}

function write(message: Reply | { id: number; event: "output"; stream: "stdout" | "stderr"; text: string; skipped?: JsonValue } | { id: number; event: "watch"; change: JsonValue } | { id: number; event: "command"; pid: number; phase: "start" | "end" }): void {
	// SAFETY: skipped is the exact ShellOutputSkip shape emitted by pi-durable;
	// JsonValue is only the wider transport representation accepted by the encoder.
	process.stdout.write(encodeMessage(message as Reply | import("./protocol.js").Message));
}

function argsOf(request: Request): unknown[] {
	return request.args.map((arg) => decodeValue(arg));
}

function handleId(value: unknown): number {
	const id = typeof value === "object" && value !== null && "$handle" in value
		? value.$handle
		: value;
	if (typeof id !== "number" || !handles.has(id)) throw new Error("worker handle is closed");
	return id;
}

function openHandle(handle: Handle): { $handle: number } {
	const id = nextHandle++;
	handles.set(id, handle);
	return { $handle: id };
}

async function handleCall(request: Request, args: unknown[]): Promise<unknown> {
	const id = handleId(args[0]);
	const handle = handles.get(id)!;
	const method = request.op.slice("handle.".length);
	if (method === "close") {
		handles.delete(id);
		await handle.value.close(BACKGROUND_CONTEXT);
		return null;
	}
	if (handle.kind === "text" && method === "readLine") {
		return handle.value.readLine(BACKGROUND_CONTEXT);
	}
	if (handle.kind === "binary" && method === "info") {
		return handle.value.info(BACKGROUND_CONTEXT);
	}
	if (handle.kind === "binary" && method === "read") {
		return handle.value.read(args[1] as number, args[2] as number, BACKGROUND_CONTEXT);
	}
	if (handle.kind === "binary" && method === "scanLines") {
		return handle.value.scanLines(
			args[1] as { startLine: number; endLine?: number },
			BACKGROUND_CONTEXT,
		);
	}
	if (handle.kind === "dir" && method === "next") {
		return handle.value.next(args[1] as number, BACKGROUND_CONTEXT);
	}
	throw new TypeError(`unsupported handle operation ${request.op}`);
}

async function dispatch(request: Request): Promise<unknown> {
	const args = argsOf(request);
	if (request.op.startsWith("handle.")) return handleCall(request, args);
	if (request.op === "hello") {
		return { capabilities: { listFiles: "listFiles" in NodeExecutionEnv.prototype } };
	}
	if (request.op === "pid") return process.pid;
	const cwd = args.at(-1);
	if (typeof cwd !== "string") throw new TypeError(`${request.op} requires cwd`);
	const env = environment(cwd);
	switch (request.op) {
		case "absolutePath": return env.absolutePath(args[0] as string, BACKGROUND_CONTEXT);
		case "joinPath": return env.joinPath(args[0] as string[], BACKGROUND_CONTEXT);
		case "readTextFile": return env.readTextFile(args[0] as string, BACKGROUND_CONTEXT);
		case "openTextLineReader": {
			const result = await env.openTextLineReader(args[0] as string, BACKGROUND_CONTEXT);
			return result.ok ? { ok: true, value: openHandle({ kind: "text", value: result.value }) } : result;
		}
		case "readTextLines": return env.readTextLines(args[0] as string, args[1] as { maxLines?: number } | undefined, BACKGROUND_CONTEXT);
		case "readBinaryFile": return env.readBinaryFile(args[0] as string, BACKGROUND_CONTEXT);
		case "openBinaryReader": {
			const result = await env.openBinaryReader(args[0] as string, args[1] as { noFollow?: boolean } | undefined, BACKGROUND_CONTEXT);
			return result.ok ? { ok: true, value: openHandle({ kind: "binary", value: result.value }) } : result;
		}
		case "writeFile": return env.writeFile(args[0] as string, args[1] as string | Uint8Array, BACKGROUND_CONTEXT);
		case "appendFile": return env.appendFile(args[0] as string, args[1] as string | Uint8Array, BACKGROUND_CONTEXT);
		case "truncateFile": return env.truncateFile(args[0] as string, args[1] as number, BACKGROUND_CONTEXT);
		case "flushFile": return env.flushFile(args[0] as string, BACKGROUND_CONTEXT);
		case "renameFile": return env.renameFile(args[0] as string, args[1] as string, BACKGROUND_CONTEXT);
		case "fileInfo": return env.fileInfo(args[0] as string, BACKGROUND_CONTEXT);
		case "listDir": return env.listDir(args[0] as string, BACKGROUND_CONTEXT);
		case "listFiles": {
			// NodeExecutionEnv gained this optional member after 1.3.0; the
			// structural view keeps this worker compatible with both shapes.
			const listing = env as NodeExecutionEnv & {
				listFiles?: NodeExecutionEnv["watch"] extends never ? never : (
					path: string,
					options: ListFilesOptions | undefined,
					context: Context,
				) => ReturnType<NodeExecutionEnv["readTextFile"]>;
			};
			if (listing.listFiles === undefined) throw new Error("listFiles is not supported");
			return listing.listFiles(args[0] as string, args[1] as ListFilesOptions | undefined, BACKGROUND_CONTEXT);
		}
		case "openDirReader": {
			const result = await env.openDirReader(args[0] as string, BACKGROUND_CONTEXT);
			return result.ok ? { ok: true, value: openHandle({ kind: "dir", value: result.value }) } : result;
		}
		case "watch": {
			const result = await env.watch(
				args[0] as readonly WatchTarget[],
				(change: WatchChange) => write({ id: request.id, event: "watch", change: encodeValue("error" in change ? { error: wireError(change.error) } : change) }),
				BACKGROUND_CONTEXT,
			);
			return result.ok
				? { ok: true, value: { handle: openHandle({ kind: "watch", value: result.value }), mode: result.value.mode } }
				: result;
		}
		case "canonicalPath": return env.canonicalPath(args[0] as string, BACKGROUND_CONTEXT);
		case "exists": return env.exists(args[0] as string, BACKGROUND_CONTEXT);
		case "createDir": return env.createDir(args[0] as string, args[1] as { recursive?: boolean } | undefined, BACKGROUND_CONTEXT);
		case "remove": return env.remove(args[0] as string, args[1] as { recursive?: boolean; force?: boolean } | undefined, BACKGROUND_CONTEXT);
		case "createTempDir": return env.createTempDir(args[0] as string | undefined, BACKGROUND_CONTEXT);
		case "createTempFile": return env.createTempFile(args[0] as { prefix?: string; suffix?: string } | undefined, BACKGROUND_CONTEXT);
		default: throw new TypeError(`unknown sandbox operation ${request.op}`);
	}
}

/** Both exec paths share this attribution; its finally emits no pid event. */
async function runWithSpawnAttribution<T>(
	env: NodeExecutionEnv,
	requestId: number,
	run: () => Promise<T>,
): Promise<T> {
	let pending = pendingSpawns.get(env);
	if (pending === undefined) {
		pending = new Set<number>();
		pendingSpawns.set(env, pending);
	}
	pending.add(requestId);
	try {
		return await run();
	} finally {
		// processRequest's settlement sweep owns end events, not this finally.
		pending.delete(requestId);
	}
}

async function execute(request: Request): Promise<void> {
	const args = argsOf(request);
	const command = args[0] as string | readonly string[];
	const supplied = (args[1] ?? {}) as Record<string, unknown>;
	const options = {
		...supplied,
		// The worker's process.env is the already-scrubbed per-user allowlist,
		// so inheriting it is the point. The caller's env remains the override.
		onOutput: (text: string, _context: unknown, info: { stream: "stdout" | "stderr"; skipped?: JsonValue }) => {
			write({ id: request.id, event: "output", stream: info.stream, text, ...(info.skipped === undefined ? {} : { skipped: encodeValue(info.skipped) }) });
		},
	};
	const cwd = args[2];
	if (typeof cwd !== "string") throw new TypeError("exec requires cwd");
	const env = environment(cwd);
	const result = await runWithSpawnAttribution(env, request.id, () =>
		env.exec(command, options as never, active.get(request.id) === undefined ? BACKGROUND_CONTEXT : withAbortSignal(active.get(request.id)!.signal, BACKGROUND_CONTEXT)),
	);
	write(result.ok ? { id: request.id, ok: true, value: encodeValue(result.value) } : errorReply(request.id, result.error, "exec"));
}

async function dispatchResult(request: Request, controller: AbortController): Promise<unknown> {
	const [op, rawArgs, cwd] = request.args;
	if (typeof op !== "string" || !Array.isArray(rawArgs) || typeof cwd !== "string") {
		throw new TypeError("result requires op, args and cwd");
	}
	if (op === "exec") {
		const args = rawArgs.map((arg) => decodeValue(arg));
		const supplied = (args[1] ?? {}) as Record<string, unknown>;
		const options = {
			...supplied,
			onOutput: (text: string, _context: unknown, info: { stream: "stdout" | "stderr"; skipped?: JsonValue }) => {
				write({ id: request.id, event: "output", stream: info.stream, text, ...(info.skipped === undefined ? {} : { skipped: encodeValue(info.skipped) }) });
			},
		};
		const env = environment(cwd);
		return runWithSpawnAttribution(env, request.id, () =>
			env.exec(args[0] as string | readonly string[], options as never, withAbortSignal(controller.signal, BACKGROUND_CONTEXT)),
		);
	}
	return dispatch({ id: request.id, op, args: [...rawArgs, cwd] });
}

function operationResultValue(result: unknown, fallbackKind: "file" | "exec"): object | null | string | number | boolean | unknown[] {
	if (typeof result === "object" && result !== null && "ok" in result && typeof result.ok === "boolean") {
		if (result.ok) return result;
		if ("error" in result) return { ok: false, error: wireError(result.error, fallbackKind) };
	}
	if (result === undefined) return null;
	if (typeof result === "string" || typeof result === "number" || typeof result === "boolean" || typeof result === "object") return result;
	throw new TypeError("unsupported operation result");
}

async function processRequest(request: Request): Promise<void> {
	if (request.id === 0 && request.op === "abort") {
		const target = request.args[0];
		if (typeof target === "number") active.get(target)?.abort();
		return;
	}
	const controller = new AbortController();
	active.set(request.id, controller);
	try {
		if (request.op === "result") {
			const forwarded = { id: request.id, op: "result.dispatch", args: request.args };
			const result = await dispatchResult(forwarded, controller);
			write({ id: request.id, ok: true, value: encodeValue(operationResultValue(result, forwarded.args[0] === "exec" ? "exec" : "file")) });
			return;
		}
		if (request.op === "exec") {
			await execute(request);
			return;
		}
		const result = await dispatch(request);
		write({ id: request.id, ok: true, value: encodeValue(operationResultValue(result, request.op === "exec" ? "exec" : "file")) });
	} catch (error) {
		write(errorReply(request.id, error, request.op === "exec" ? "exec" : "file"));
	} finally {
		active.delete(request.id);
		// pi-durable removes a pid BEFORE the exec promise resolves. The
		// registry hook therefore sees the request still active; this is the
		// settlement boundary that forgets ordinary pids and emits their end.
		for (const observer of commandObservers.values()) observer.settleRequest(request.id);
	}
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (line.trim() === "") continue;
		try {
			void processRequest(JSON.parse(line) as Request);
		} catch (error) {
			process.stderr.write(`sandbox worker request error: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	}
});
process.stdin.on("end", () => {
	for (const controller of active.values()) controller.abort();
	for (const env of environments.values()) void env.cleanup(BACKGROUND_CONTEXT);
	for (const handle of handles.values()) void handle.value.close(BACKGROUND_CONTEXT);
	process.exit(0);
});
