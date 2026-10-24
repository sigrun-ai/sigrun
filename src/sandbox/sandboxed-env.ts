/** Forward one ExecutionEnv over a user's worker, including live handles. */

import type { Context } from "@earendil-works/chord/context";
import { isAbsolute, resolve } from "node:path";
import {
	ExecutionError,
	FileError,
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	type FileInfo,
	type FileListing,
	type FileSystem,
	type FileWatcher,
	type LineScan,
	type ListFilesOptions,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type ShellOutputInfo,
	type TextLine,
	type TextLineReader,
	type WatchChange,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import {
	decodeError,
	decodeValue,
	decodeWatchChange,
	type WireError,
	type DecodedValue,
	type Event,
	type JsonValue,
} from "./protocol.js";
import type { WorkerClient } from "./pool.js";

export interface RemoteHandle {
	close(context: Context): Promise<void>;
}

function wireArgs(values: readonly unknown[]): JsonValue[] {
	// The protocol encoder is intentionally shared with the worker; casting
	// here is safe because the return value is checked as it is encoded.
	return values.map((value) => {
		if (value === undefined) return null;
		if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
		if (Array.isArray(value)) return wireArgs(value);
		if (typeof value === "object" && value !== null) {
			const result: Record<string, JsonValue> = {};
			for (const [key, item] of Object.entries(value)) {
				if (item !== undefined && typeof item !== "function") result[key] = wireArgs([item])[0]!;
			}
			return result;
		}
		return value as JsonValue;
	});
}

function decoded<T>(value: JsonValue): T {
	return restoreResult(decodeValue(value)) as T;
}

function restoreResult(value: DecodedValue): DecodedValue {
	if (Array.isArray(value)) return value.map(restoreResult);
	if (typeof value !== "object" || value === null || value instanceof Uint8Array || "$handle" in value) return value;
	if ("ok" in value && value.ok === false && "error" in value) {
		const candidate = value.error;
		if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) && !(candidate instanceof Uint8Array) && !("$handle" in candidate)) {
			const kind = candidate.kind;
			const code = candidate.code;
			const message = candidate.message;
			const path = candidate.path;
			if ((kind === "file" || kind === "exec") && typeof code === "string" && typeof message === "string") {
				const wire: WireError = { kind, code, message, ...(typeof path === "string" ? { path } : {}) };
				// SAFETY: pi-durable errors are class instances at the API boundary;
				// DecodedValue deliberately describes JSON-only structural data.
				return { ok: false, error: decodeError(wire) } as unknown as DecodedValue;
			}
		}
	}
	const result: Record<string, DecodedValue> = {};
	for (const [key, item] of Object.entries(value)) result[key] = restoreResult(item);
	return result;
}

function handleId(value: unknown): number {
	if (typeof value !== "object" || value === null || !("$handle" in value)) {
		throw new Error("sandbox worker did not return a handle");
	}
	const id = value.$handle;
	if (typeof id !== "number") throw new Error("sandbox worker returned an invalid handle");
	return id;
}

abstract class BaseRemoteHandle implements RemoteHandle {
	private closed = false;
	constructor(protected readonly client: WorkerClient, protected readonly id: number) {}
	async close(context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			if (this.client.hasHandle(this.id)) {
				await this.client.call("handle.close", [this.id], undefined, context);
			}
		} finally {
			this.client.releaseHandle(this.id);
		}
	}
	protected async call<T>(method: string, args: JsonValue[], context: Context): Promise<T> {
		if (this.closed) throw new FileError("invalid", "sandbox handle is closed");
		const value = await this.client.call(`handle.${method}`, [this.id, ...args], undefined, context);
		return decoded<T>(value);
	}
}

class RemoteTextLineReader extends BaseRemoteHandle implements TextLineReader {
	readLine(context: Context): Promise<Result<TextLine | undefined, FileError>> {
		return this.call("readLine", [], context);
	}
}

class RemoteBinaryReader extends BaseRemoteHandle implements BinaryReader {
	info(context: Context): Promise<Result<FileInfo, FileError>> {
		return this.call("info", [], context);
	}
	read(offset: number, length: number, context: Context): Promise<Result<Uint8Array, FileError>> {
		return this.call("read", [offset, length], context);
	}
	scanLines(options: { startLine: number; endLine?: number }, context: Context): Promise<Result<LineScan, FileError>> {
		return this.call("scanLines", [options], context);
	}
}

class RemoteDirReader extends BaseRemoteHandle implements DirReader {
	next(maxEntries: number, context: Context): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
		return this.call("next", [maxEntries], context);
	}
}

class RemoteWatcher extends BaseRemoteHandle implements FileWatcher {
	readonly mode: "native" | "polling";
	constructor(client: WorkerClient, id: number, mode: "native" | "polling") {
		super(client, id);
		this.mode = mode;
	}
}

/** Every required FileSystem and Shell member is explicitly forwarded. */
export class SandboxedExecutionEnv implements ExecutionEnv {
	readonly id: string;
	private currentCwd: string;
	private listFilesForwarder?: FileSystem["listFiles"];

	constructor(private readonly client: WorkerClient, cwd: string) {
		this.id = `sandbox:${client.user}`;
		this.currentCwd = cwd;
	}

	get cwd(): string {
		return this.currentCwd;
	}
	set cwd(value: string) {
		this.currentCwd = isAbsolute(value) ? value : resolve(this.currentCwd, value);
	}

	get listFiles(): FileSystem["listFiles"] {
		return this.listFilesForwarder;
	}

	private async call<T>(op: string, args: unknown[], context: Context, onEvent?: (event: Event) => void): Promise<T> {
		// Result is the ExecutionEnv error channel; only transport failures
		// reject. Never turn an ordinary ENOENT into an RPC exception.
		const value = await this.client.call("result", wireArgs([op, args, this.currentCwd]), onEvent, context);
		// A capability reply is consumed by the client at worker start. Install
		// the optional member only after the worker has actually advertised it.
		const capabilities = await this.client.capabilities();
		if (capabilities.listFiles) this.listFilesForwarder ??= this.forwardListFiles.bind(this);
		return decoded<T>(value);
	}

	private forwardListFiles(path: string, options: ListFilesOptions | undefined, context: Context): Promise<Result<FileListing, FileError>> {
		return this.call("listFiles", [path, options], context);
	}

	absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.call("absolutePath", [path], context);
	}
	joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
		return this.call("joinPath", [parts], context);
	}
	readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.call("readTextFile", [path], context);
	}
	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const result = await this.call<Result<DecodedValue, FileError>>("openTextLineReader", [path], context);
		return result.ok ? { ok: true, value: new RemoteTextLineReader(this.client, handleId(result.value)) } : result;
	}
	readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
		return this.call("readTextLines", [path, options], context);
	}
	readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return this.call("readBinaryFile", [path], context);
	}
	async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
		const result = await this.call<Result<DecodedValue, FileError>>("openBinaryReader", [path, options], context);
		return result.ok ? { ok: true, value: new RemoteBinaryReader(this.client, handleId(result.value)) } : result;
	}
	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.call("writeFile", [path, content], context);
	}
	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.call("appendFile", [path, content], context);
	}
	truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		return this.call("truncateFile", [path, size], context);
	}
	flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		return this.call("flushFile", [path], context);
	}
	renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		return this.call("renameFile", [sourcePath, destinationPath], context);
	}
	fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		return this.call("fileInfo", [path], context);
	}
	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		return this.call("listDir", [path], context);
	}
	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const result = await this.call<Result<DecodedValue, FileError>>("openDirReader", [path], context);
		return result.ok ? { ok: true, value: new RemoteDirReader(this.client, handleId(result.value)) } : result;
	}
	async watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
		const result = await this.call<Result<{ handle: DecodedValue; mode: "native" | "polling" }, FileError>>(
			"watch",
			[targets],
			context,
			(event) => {
				if (event.event === "watch") onChange(decodeWatchChange(decodeValue(event.change)));
			},
		);
		return result.ok
			? { ok: true, value: new RemoteWatcher(this.client, handleId(result.value.handle), result.value.mode) }
			: result;
	}
	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.call("canonicalPath", [path], context);
	}
	exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		return this.call("exists", [path], context);
	}
	createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		return this.call("createDir", [path, options], context);
	}
	remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		return this.call("remove", [path, options], context);
	}
	createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		return this.call("createTempDir", [prefix], context);
	}
	createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
		return this.call("createTempFile", [options], context);
	}
	async cleanup(_context: Context): Promise<void> {
		// NO-OP: this worker is shared by all of the user's conversations;
		// cleanup here would kill another conversation's live commands.
	}
	exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		const wireOptions = { ...(options ?? {}), inheritEnv: false };
		delete wireOptions.onOutput;
		return this.call("exec", [command, wireOptions], context, (event) => {
			if (event.event !== "output") return;
			const info: ShellOutputInfo = {
				stream: event.stream,
				...(event.skipped === undefined ? {} : { skipped: event.skipped }),
			};
			options?.onOutput?.(event.text, context, info);
		});
	}
}
