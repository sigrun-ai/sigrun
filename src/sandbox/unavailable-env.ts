/** An ExecutionEnv that can never touch a filesystem or start a process. */

import type { Context } from "@earendil-works/chord/context";
import {
	ExecutionError,
	FileError,
	type ExecutionEnv,
	type FileInfo,
	type FileWatcher,
	type ListFilesOptions,
	type ShellExecOptions,
	type ShellExecResult,
	type WatchChange,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";

export class UnavailableExecutionEnv implements ExecutionEnv {
	readonly id = "unavailable";
	cwd = ".";
	private readonly message: string;

	constructor(reason: string) {
		this.message = `isolation_unavailable: ${reason}`;
	}

	private file<T>(): Promise<{ ok: false; error: FileError }> {
		return Promise.resolve({ ok: false, error: new FileError("permission_denied", this.message) });
	}

	private shell(): Promise<{ ok: false; error: ExecutionError }> {
		return Promise.resolve({ ok: false, error: new ExecutionError("spawn_error", this.message) });
	}

	absolutePath(): ReturnType<ExecutionEnv["absolutePath"]> { return this.file(); }
	joinPath(): ReturnType<ExecutionEnv["joinPath"]> { return this.file(); }
	readTextFile(): ReturnType<ExecutionEnv["readTextFile"]> { return this.file(); }
	openTextLineReader(): ReturnType<ExecutionEnv["openTextLineReader"]> { return this.file(); }
	readTextLines(): ReturnType<ExecutionEnv["readTextLines"]> { return this.file(); }
	readBinaryFile(): ReturnType<ExecutionEnv["readBinaryFile"]> { return this.file(); }
	openBinaryReader(): ReturnType<ExecutionEnv["openBinaryReader"]> { return this.file(); }
	writeFile(): ReturnType<ExecutionEnv["writeFile"]> { return this.file(); }
	appendFile(): ReturnType<ExecutionEnv["appendFile"]> { return this.file(); }
	truncateFile(): ReturnType<ExecutionEnv["truncateFile"]> { return this.file(); }
	flushFile(): ReturnType<ExecutionEnv["flushFile"]> { return this.file(); }
	renameFile(): ReturnType<ExecutionEnv["renameFile"]> { return this.file(); }
	fileInfo(): ReturnType<ExecutionEnv["fileInfo"]> { return this.file<FileInfo>(); }
	listDir(): ReturnType<ExecutionEnv["listDir"]> { return this.file<FileInfo[]>(); }
	listFiles(_path: string, _options: ListFilesOptions | undefined, _context: Context): ReturnType<NonNullable<ExecutionEnv["listFiles"]>> {
		return this.file();
	}
	openDirReader(): ReturnType<ExecutionEnv["openDirReader"]> { return this.file(); }
	watch(_targets: readonly WatchTarget[], _onChange: (change: WatchChange) => void, _context: Context): Promise<{ ok: false; error: FileError }> {
		return this.file<FileWatcher>();
	}
	canonicalPath(): ReturnType<ExecutionEnv["canonicalPath"]> { return this.file(); }
	exists(): ReturnType<ExecutionEnv["exists"]> { return this.file<boolean>(); }
	createDir(): ReturnType<ExecutionEnv["createDir"]> { return this.file(); }
	remove(): ReturnType<ExecutionEnv["remove"]> { return this.file(); }
	createTempDir(): ReturnType<ExecutionEnv["createTempDir"]> { return this.file(); }
	createTempFile(): ReturnType<ExecutionEnv["createTempFile"]> { return this.file(); }
	cleanup(): Promise<never> {
		return Promise.reject(new FileError("permission_denied", this.message));
	}
	exec(_command: string | readonly string[], _options: ShellExecOptions | undefined, _context: Context): ReturnType<ExecutionEnv["exec"]> {
		return this.shell() as Promise<{ ok: false; error: ExecutionError }>;
	}
}
