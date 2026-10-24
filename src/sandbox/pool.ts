/** Per-user worker lifecycle and the client side of the stdio protocol. */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import {
	decodeError,
	decodeMessage,
	decodeValue,
	encodeMessage,
	encodeValue,
	type DecodedValue,
	type Event,
	type JsonValue,
	type Reply,
} from "./protocol.js";
import type { UserPolicy } from "./policy.js";

export interface Launch {
	command: string;
	args: string[];
	env: Record<string, string>;
}
export interface Launcher {
	(policy: UserPolicy): Launch;
}
export interface WorkerEntry {
	command: string;
	args: string[];
}
export interface WorkerCapabilities {
	listFiles: boolean;
}
export type WorkerEvent = Event;

type Pending = {
	op: string;
	resolve(value: unknown): void;
	reject(error: Error): void;
	onEvent?: (event: WorkerEvent) => void;
	context?: Context;
	onAbort?: () => void;
	watch?: boolean;
};

function crashError(op: string, user: string, detail: string): Error {
	const message = `sandbox worker for ${user} exited (${detail})`;
	// The M1 protocol names these transport failures "crashed" and "io".
	// pi-durable 1.3.0 has not added those codes to its public unions yet;
	// keep the protocol codes visible to callers rather than hiding the crash
	// behind a generic success or an unrelated spawn error.
	return op === "exec"
		? new ExecutionError("crashed" as ExecutionError["code"], message)
		: new FileError("io" as FileError["code"], message);
}

class WorkerProcess {
	readonly child: ChildProcess;
	readonly exit: Promise<void>;
	readonly capabilities: Promise<WorkerCapabilities>;
	private buffer = "";
	private nextRequest = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly watchEvents = new Map<number, (event: WorkerEvent) => void>();
	private readonly watchHandles = new Map<number, number>();
	private readonly commandGroups = new Set<number>();
	private drainedResolve: (() => void) | undefined;
	private drained: Promise<void> | undefined;
	private stopPromise: Promise<void> | undefined;
	private exited = false;
	retiring = false;

	constructor(
		private readonly client: WorkerClient,
		launch: Launch,
	) {
		this.child = spawn(launch.command, launch.args, {
			env: launch.env,
			// Own a process group: pi-durable's commands are detached too, so
			// stopping only the worker can orphan them. Group cleanup reaches
			// the command groups below this worker, including after SIGKILL.
			detached: process.platform !== "win32",
			// Exactly three descriptors: pi-durable gives every command its own
			// pipes, so neither side of this IPC channel reaches a command.
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child.stdout!.setEncoding("utf8");
		this.child.stdout!.on("data", (chunk: string) => this.receive(chunk));
		this.child.stderr!.setEncoding("utf8");
		let stderr = "";
		this.child.stderr!.on("data", (chunk: string) => {
			stderr += chunk;
			for (;;) {
				const newline = stderr.indexOf("\n");
				if (newline < 0) break;
				const line = stderr.slice(0, newline).trimEnd();
				stderr = stderr.slice(newline + 1);
				if (line !== "") this.client.log(`sandbox[${this.client.user}] ${line}`);
			}
		});
		this.exit = new Promise<void>((resolve) => {
			this.child.once("error", () => { this.exited = true; });
			this.child.once("exit", (code, signal) => {
				this.exited = true;
				// A direct crash cannot run the worker's stdin-close cleanup.
				// The negative pid addresses the worker's whole process group;
				// ESRCH simply means every member is already gone.
				this.killGroup("SIGKILL");
				this.failAll(code, signal);
				this.client.processExited(this);
				resolve();
			});
		});
		this.capabilities = this.request<{ capabilities: WorkerCapabilities }>("hello", []).then((value) => {
			// The canonical hello shape is {capabilities: {listFiles}}.
			return { listFiles: value.capabilities.listFiles === true };
		});
		// A caller will observe this through its first operation; attaching a
		// rejection sink here prevents a failed boot becoming unhandled.
		void this.capabilities.catch(() => {});
	}

	get running(): boolean {
		return !this.exited && this.child.exitCode === null && this.child.signalCode === null;
	}

	get inFlight(): number {
		return this.pending.size;
	}

	commandGroupsSnapshot(): readonly number[] {
		return [...this.commandGroups];
	}

	request<T>(op: string, args: JsonValue[], onEvent?: (event: WorkerEvent) => void, context?: Context, failureOp = op): Promise<T> {
		if (!this.running) return Promise.reject(crashError(op, this.client.user, "not running"));
		if (context?.abortSignal?.aborted) {
			return Promise.reject(op === "exec"
				? new ExecutionError("aborted", "aborted")
				: new FileError("aborted", "aborted"));
		}
		const id = this.nextRequest++;
		return new Promise<T>((resolve, reject) => {
			if (op === "handle.close" && typeof args[0] === "number") {
				const watchRequest = this.watchHandles.get(args[0]);
				if (watchRequest !== undefined) {
					this.watchEvents.delete(watchRequest);
					this.watchHandles.delete(args[0]);
				}
			}
			const pending: Pending = {
				op: failureOp,
				watch: op === "result" && args[0] === "watch",
				resolve: (value) => resolve(value as T),
				reject,
				onEvent,
				context,
			};
			this.pending.set(id, pending);
			if (context?.abortSignal !== undefined) {
				const signal = context.abortSignal;
				const abort = () => {
					if (!this.pending.has(id) || !this.running) return;
					this.child.stdin!.write(encodeMessage({ id: 0, op: "abort", args: [id] }));
				};
				pending.onAbort = abort;
				signal.addEventListener("abort", abort, { once: true });
			}
			this.child.stdin!.write(encodeMessage({ id, op, args }), (error) => {
				if (error !== null && error !== undefined) this.settleError(id, error);
			});
		});
	}

	markRetiring(): void {
		this.retiring = true;
	}

	async drainAndStop(): Promise<void> {
		if (!this.running) return;
		// A stop during a policy change drains calls already handed to the
		// worker; it never races their still-running commands.
		if (this.inFlight > 0) {
			this.drained ??= new Promise<void>((resolve) => { this.drainedResolve = resolve; });
			await this.drained;
		}
		await this.stop();
	}

	stop(): Promise<void> {
		if (this.stopPromise !== undefined) return this.stopPromise;
		this.stopPromise = (async () => {
			if (!this.running) {
				this.killGroup("SIGKILL");
				await this.exit;
				return;
			}
			const killTimer = setTimeout(() => {
				// The worker may be wedged and unable to run its own cleanup;
				// kill its group, never just the Node process.
				this.killGroup("SIGKILL");
			}, 2_000);
			killTimer.unref();
			try {
				// Let the worker's stdin-close hook run pi-durable cleanup for
				// tracked command groups before the forced group-kill fallback.
				this.child.stdin!.end();
				await this.exit;
			} finally {
				clearTimeout(killTimer);
				this.killGroup("SIGKILL");
			}
		})();
		return this.stopPromise;
	}

	private killGroup(signal: NodeJS.Signals): void {
		const pid = this.child.pid;
		if (pid === undefined || process.platform === "win32") {
			this.child.kill(signal);
			return;
		}
		// pi-durable puts each command in a NEW process group, so killing only
		// -workerPid cannot reach it. The worker reports actual spawned pids;
		// kill each command's group as well as the worker's group. ESRCH means
		// a group already exited.
		const groups = new Set<number>();
		for (const commandPid of this.commandGroups) groups.add(commandPid);
		this.commandGroups.clear();
		groups.add(pid);
		for (const group of groups) {
			try {
				process.kill(-group, signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
	}

	private receive(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) break;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line === "") continue;
			let message: ReturnType<typeof decodeMessage>;
			try {
				message = decodeMessage(line);
			} catch (error) {
				this.client.log(`sandbox[${this.client.user}] invalid worker message: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			const pending = this.pending.get(message.id);
			if ("event" in message) {
				if (message.event === "command") {
					if (message.phase === "start") this.commandGroups.add(message.pid);
					else this.commandGroups.delete(message.pid);
					continue;
				}
				const listener = pending?.onEvent ?? this.watchEvents.get(message.id);
				if (listener === undefined) continue;
				try {
					listener(message);
				} catch (error) {
					if (pending !== undefined) this.settleError(message.id, error);
					else this.client.log(`sandbox[${this.client.user}] watcher callback failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				continue;
			}
			if (pending === undefined) continue;
			this.pending.delete(message.id);
			this.removeAbort(pending);
			if (message.ok) {
				try {
					const value = decodeValue(message.value);
					this.client.valueDecoded(value);
					if (pending.watch && pending.onEvent !== undefined) {
						this.watchEvents.set(message.id, pending.onEvent);
						const handle = this.findHandle(value);
						if (handle !== undefined) this.watchHandles.set(handle, message.id);
					}
					pending.resolve(value);
				} catch (error) {
					pending.reject(error instanceof Error ? error : new Error(String(error)));
				}
			} else {
				pending.reject(decodeError(message.error));
			}
			this.maybeDrained();
		}
	}

	private findHandle(value: DecodedValue): number | undefined {
		if (Array.isArray(value)) {
			for (const item of value) {
				const found = this.findHandle(item);
				if (found !== undefined) return found;
			}
			return undefined;
		}
		if (typeof value !== "object" || value === null || value instanceof Uint8Array) return undefined;
		if ("$handle" in value) return typeof value.$handle === "number" ? value.$handle : undefined;
		for (const item of Object.values(value)) {
			const found = this.findHandle(item);
			if (found !== undefined) return found;
		}
		return undefined;
	}

	private settleError(id: number, error: unknown): void {
		const pending = this.pending.get(id);
		if (pending === undefined) return;
		this.pending.delete(id);
		this.removeAbort(pending);
		pending.reject(error instanceof Error ? error : new Error(String(error)));
		this.maybeDrained();
	}

	private removeAbort(pending: Pending): void {
		if (pending.onAbort !== undefined) {
			pending.context?.abortSignal?.removeEventListener("abort", pending.onAbort);
		}
	}

	private failAll(code: number | null, signal: NodeJS.Signals | null): void {
		const detail = signal ?? `code ${code ?? "unknown"}`;
		for (const [id, pending] of this.pending) {
			this.removeAbort(pending);
			pending.reject(crashError(pending.op, this.client.user, detail));
			this.pending.delete(id);
		}
		this.drainedResolve?.();
		this.drainedResolve = undefined;
		this.watchEvents.clear();
		this.watchHandles.clear();
		this.client.clearHandles();
	}

	private maybeDrained(): void {
		if (this.inFlight === 0) {
			this.drainedResolve?.();
			this.drainedResolve = undefined;
			this.client.callSettled();
		}
	}
}

export class WorkerClient {
	readonly user: string;
	private policy: UserPolicy;
	private policyJson: string;
	private process: WorkerProcess | undefined;
	private replacement: Promise<WorkerProcess> | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private readonly handles = new Set<number>();
	private closed = false;

	constructor(
		policy: UserPolicy,
		private readonly pool: {
			launcher: Launcher;
			idleMinutes(): number;
			log(line: string): void;
			workerEntry: WorkerEntry;
		},
	) {
		this.user = policy.user;
		this.policy = policy;
		this.policyJson = JSON.stringify(policy);
	}

	/** @internal Pool-only policy change notification. */
	updatePolicy(policy: UserPolicy): void {
		const json = JSON.stringify(policy);
		if (json === this.policyJson) return;
		this.policy = policy;
		this.policyJson = json;
		this.process?.markRetiring();
		// Start the handoff now, but do not spawn until the old process has
		// drained. The next call joins this same promise.
		if (this.process !== undefined) void this.ensureProcess().catch(() => {});
		// Retiring workers are owned by the drain path, never the idle clock.
		this.clearIdle();
	}

	log(line: string): void {
		this.pool.log(line);
	}

	async call(op: string, args: JsonValue[], onEvent?: (event: WorkerEvent) => void, context?: Context): Promise<JsonValue> {
		const crashOp = op === "result" && args[0] === "exec" ? "exec" : op;
		if (this.closed) throw crashError(crashOp, this.user, "client stopped");
		this.clearIdle();
		const process = await this.ensureProcess();
		try {
			const result = await process.request(op, args, onEvent, context, crashOp);
			return encodeValue(result);
		} finally {
			this.callSettled();
		}
	}

	/** Decode a wire failure into pi-durable's typed error (test/tool seam). */
	async decodeError(reply: Reply): Promise<never> {
		if (reply.ok) throw new Error("not an error reply");
		throw decodeError(reply.error);
	}

	capabilities(): Promise<WorkerCapabilities> {
		return this.ensureProcess().then((process) => process.capabilities);
	}

	openHandles(): number {
		return this.handles.size;
	}

	/** Read-only snapshot of command groups currently tracked for crash cleanup. */
	trackedCommandGroups(): number[] {
		return [...(this.process?.commandGroupsSnapshot() ?? [])];
	}

	/** Current process id without starting a replacement (lifecycle probe). */
	get pid(): number | undefined {
		return this.process?.running ? this.process.child.pid : undefined;
	}

	valueDecoded(value: DecodedValue): void {
		this.collectHandles(value);
		this.armIdle();
	}

	private collectHandles(value: DecodedValue): void {
		if (Array.isArray(value)) {
			for (const item of value) this.collectHandles(item);
			return;
		}
		if (
			typeof value !== "object" ||
			value === null ||
			value instanceof Uint8Array
		) return;
		if ("$handle" in value) {
			const id = value.$handle;
			if (typeof id === "number") this.handles.add(id);
			return;
		}
		for (const item of Object.values(value)) this.collectHandles(item);
	}

	hasHandle(id: number): boolean {
		return this.handles.has(id);
	}

	releaseHandle(id: number): void {
		this.handles.delete(id);
		this.armIdle();
	}

	clearHandles(): void {
		this.handles.clear();
	}

	processExited(process: WorkerProcess): void {
		if (this.process === process) this.armIdle();
	}

	callSettled(): void {
		this.armIdle();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.clearIdle();
		this.clearHandles();
		const process = this.process;
		if (process !== undefined) void process.stop();
	}

	async stop(): Promise<void> {
		this.close();
		await this.replacement?.catch(() => {});
		await this.process?.stop();
	}

	private async ensureProcess(): Promise<WorkerProcess> {
		if (this.closed) throw new Error(`sandbox client for ${this.user} is stopped`);
		if (this.process?.running && !this.process.retiring) return this.process;
		if (this.replacement !== undefined) return this.replacement;
		this.replacement = (async () => {
			const previous = this.process;
			if (previous !== undefined) await previous.drainAndStop();
			if (this.closed) throw new Error(`sandbox client for ${this.user} is stopped`);
			const launch = this.pool.launcher(this.policy);
			const process = new WorkerProcess(this, launch);
			this.process = process;
			await process.capabilities;
			return process;
		})().finally(() => {
			this.replacement = undefined;
		});
		return this.replacement;
	}

	private clearIdle(): void {
		if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private armIdle(): void {
		this.clearIdle();
		if (
			this.closed ||
			this.handles.size > 0 ||
			this.process === undefined ||
			!this.process.running ||
			this.process.retiring ||
			this.process.inFlight > 0
		) return;
		const minutes = this.pool.idleMinutes();
		if (!Number.isFinite(minutes) || minutes <= 0) return;
		this.idleTimer = setTimeout(() => {
			const process = this.process;
			if (process !== undefined && process.inFlight === 0 && this.handles.size === 0) {
				process.markRetiring();
				void process.stop();
			}
		}, minutes * 60_000);
		this.idleTimer.unref();
	}
}

export class WorkerPool {
	private readonly clients = new Map<string, WorkerClient>();

	constructor(private readonly opts: {
		launcher: Launcher;
		idleMinutes: () => number;
		log: (line: string) => void;
		workerEntry: WorkerEntry;
	}) {}

	client(policy: UserPolicy): WorkerClient {
		let client = this.clients.get(policy.user);
		if (client === undefined) {
			client = new WorkerClient(policy, this.opts);
			this.clients.set(policy.user, client);
		} else {
			client.updatePolicy(policy);
		}
		return client;
	}

	async stopUser(user: string): Promise<void> {
		const client = this.clients.get(user);
		if (client === undefined) return;
		this.clients.delete(user);
		await client.stop();
	}

	async stopAll(): Promise<void> {
		const clients = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(clients.map((client) => client.stop()));
	}
}

/** Prefer the built sibling; source checkouts run the TypeScript entry via tsx. */
export function resolveWorkerEntry(coreRoot: string): WorkerEntry {
	const built = join(import.meta.dirname, "worker.js");
	if (existsSync(built)) return { command: process.execPath, args: [built] };
	return {
		command: process.execPath,
		args: ["--import", "tsx", join(coreRoot, "src", "sandbox", "worker.ts")],
	};
}

/** The OS-independent test launcher: no helper, only the worker entry. */
export function testLauncher(workerEntry: WorkerEntry): Launcher {
	return (policy) => ({
		command: workerEntry.command,
		args: [...workerEntry.args],
		env: { ...policy.env },
	});
}

/** The production launcher applies Landlock before exec'ing the Node worker. */
export function sandboxLauncher(helper: string, workerEntry: WorkerEntry): Launcher {
	return (policy) => ({
		command: helper,
		args: ["run", "--", workerEntry.command, ...workerEntry.args],
		env: {
			...policy.env,
			SIGRUN_SANDBOX_POLICY: JSON.stringify({
				ro: policy.ro,
				rw: policy.rw,
				minAbi: 6,
				...(policy.uid === undefined ? {} : { uid: policy.uid }),
				...(policy.gid === undefined ? {} : { gid: policy.gid }),
				...(policy.groups === undefined ? {} : { groups: policy.groups }),
			}),
		},
	});
}
