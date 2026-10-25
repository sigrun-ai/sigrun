/** Core-owned per-user service processes. Workers and services are siblings. */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { HandlerContext, ServiceHandle, UserService } from "../extension.js";
import type { ManagedPaths } from "../sandbox/grants.js";
import { validateGrantPath } from "../sandbox/grants.js";
import type { LaunchService } from "../sandbox/launch.js";
import type { UserPolicy } from "../sandbox/policy.js";

/** Replay is capped so a noisy service cannot grow core memory without bound. */
export const SERVICE_STDIO_REPLAY_BYTES = 64 * 1024;
const SERVICE_STDIO_TRUNCATED = "[service output truncated]\n";

class SharedServiceStream {
	private readonly chunks: Uint8Array[] = [];
	private bytes = 0;
	private truncated = false;
	private readonly controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
	private ended = false;

	get retainedBytes(): number { return this.bytes; }

	setHandles(count: number): void {
		if (count === 0) {
			this.chunks.length = 0;
			this.bytes = 0;
			this.truncated = false;
		}
	}

	stream(): ReadableStream<Uint8Array> {
		return new ReadableStream<Uint8Array>({
			start: (controller) => {
				if (this.truncated) controller.enqueue(new TextEncoder().encode(SERVICE_STDIO_TRUNCATED));
				for (const chunk of this.chunks) controller.enqueue(chunk);
				if (this.ended) controller.close();
				else this.controllers.add(controller);
			},
			cancel: (reason) => {
				for (const controller of this.controllers) {
					try { controller.error(reason); } catch { /* already closed */ }
				}
				this.controllers.clear();
			},
		});
	}

	write(chunk: Uint8Array): void {
		if (this.ended) return;
		const copy = new Uint8Array(chunk);
		this.chunks.push(copy);
		this.bytes += copy.byteLength;
		while (this.bytes > SERVICE_STDIO_REPLAY_BYTES && this.chunks.length > 0) {
			const dropped = this.chunks.shift()!;
			this.bytes -= dropped.byteLength;
			this.truncated = true;
		}
		if (this.bytes > SERVICE_STDIO_REPLAY_BYTES) {
			const last = this.chunks[this.chunks.length - 1]!;
			const excess = this.bytes - SERVICE_STDIO_REPLAY_BYTES;
			this.chunks[0] = last.subarray(excess);
			this.bytes = SERVICE_STDIO_REPLAY_BYTES;
			this.truncated = true;
		}
		for (const controller of this.controllers) {
			try { controller.enqueue(copy); } catch { this.controllers.delete(controller); }
		}
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		for (const controller of this.controllers) {
			try { controller.close(); } catch { /* already closed */ }
		}
		this.controllers.clear();
	}
}

export type ServiceStatus = {
	slug: string;
	name: string;
	user: string;
	state: "running" | "idle" | "failed";
	lastError?: string;
};
type Exit = { code: number | null; signal: string | null };
type Live = {
	child: ChildProcessWithoutNullStreams;
	exited: Promise<Exit>;
	handles: number;
	timer?: NodeJS.Timeout;
	lastTraffic: number;
	stderr: string[];
	stdout: SharedServiceStream;
	stderrStream: SharedServiceStream;
	terminal: boolean;
};
type Entry = {
	key: string;
	slug: string;
	name: string;
	user: string;
	declaration: UserService;
	packageDir: string;
	starting?: Promise<void>;
	live?: Live;
	terminal: boolean;
	failures: number[];
	lastError?: string;
};

function within(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}
function packageDirectory(entry: string, packageDir?: string): string {
	if (packageDir !== undefined) return realpathSync(packageDir);
	const path = entry.startsWith("file://") ? new URL(entry) : undefined;
	return realpathSync(path === undefined ? resolve(entry, "..") : new URL(".", path));
}
function tail(lines: readonly string[]): string {
	return lines.slice(-20).join("\n");
}
function serviceError(entry: Entry): Error {
	return new Error(`service ${entry.slug}/${entry.name} for ${entry.user} failed${entry.lastError === undefined || entry.lastError === "" ? "" : `:\n${entry.lastError}`}`);
}

export class UserServices {
	private readonly entries = new Map<string, Entry>();
	private readonly declarations = new Map<string, readonly UserService[]>();
	private readonly directories = new Map<string, string>();
	private closed = false;

	constructor(private readonly deps: {
		launch: LaunchService;
		policyFor(user: string): UserPolicy | { reason: string };
		isolationActive(): boolean;
		now(): number;
		managed?: ManagedPaths;
	}) {}

	register(slug: string, declarations: readonly UserService[], packageDir: string): void {
		this.declarations.set(slug, declarations);
		this.directories.set(slug, packageDir);
	}

	/** A load/re-key failure stops everything the extension had started. */
	quarantine(slug: string): Promise<void> {
		this.declarations.delete(slug);
		this.directories.delete(slug);
		return this.stopSlug(slug);
	}

	/** Only a committed write to THIS user's settings for THIS slug clears its failure fence. */
	settingsChanged(slug: string, user: string): void {
		for (const entry of this.entries.values()) {
			if (entry.slug === slug && entry.user === user) {
				entry.failures = [];
				entry.lastError = undefined;
				if (entry.live === undefined) this.entries.delete(entry.key);
			}
		}
	}

	/** Retained replay bytes, exposed for lifecycle diagnostics and tests. */
	retainedStdioBytes(slug: string, name: string, user: string): { stdout: number; stderr: number } {
		const live = this.entries.get(`${slug}\0${name}\0${user}`)?.live;
		return { stdout: live?.stdout.retainedBytes ?? 0, stderr: live?.stderrStream.retainedBytes ?? 0 };
	}

	statuses(): ServiceStatus[] {
		return [...this.entries.values()].flatMap((entry) => {
			const live = entry.live;
			const failed = live === undefined && entry.failures.length >= 3;
			// A starting process is not failed, and one/two crashes are
			// retryable rather than a persistent failed service. Do not expose
			// a stale entry in either case; the next connect owns the restart.
			if (live === undefined && !failed) return [];
			return [{
				slug: entry.slug,
				name: entry.name,
				user: entry.user,
				state: failed ? "failed" : live!.handles === 0 ? "idle" : "running",
				...(failed && entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
			}];
		});
	}

	async connect(slug: string, name: string, user: string, ctx: HandlerContext = { abortSignal: undefined }): Promise<ServiceHandle> {
		if (this.closed) throw new Error("user services are stopped");
		const declaration = this.declarations.get(slug)?.find((candidate) => candidate.name === name);
		if (declaration === undefined) throw new Error(`unknown service "${slug}/${name}"`);
		const key = `${slug}\0${name}\0${user}`;
		let entry = this.entries.get(key);
		if (entry === undefined) {
			entry = {
				key, slug, name, user, declaration,
				packageDir: this.directories.get(slug)!,
				failures: [],
				terminal: false,
			};
			// Only a settings change can clear the fence; a fresh restart
			// entry never inherits another entry's crash history.
			const previous = this.entries.get(key);
			if (previous !== undefined && previous.failures.length > 0 && previous.live === undefined) {
				entry.failures = [...previous.failures];
				entry.lastError = previous.lastError;
			}
			this.entries.set(key, entry);
		}
		if (entry.live === undefined && entry.failures.length >= 3) throw serviceError(entry);
		if (entry.live !== undefined) return this.attach(entry);
		if (entry.starting === undefined) {
			const starting = this.start(entry, ctx);
			entry.starting = starting;
			void starting.finally(() => {
				if (entry?.starting === starting) entry.starting = undefined;
			}).catch(() => {});
		}
		await entry.starting;
		return this.attach(entry);
	}

	private async start(entry: Entry, ctx: HandlerContext): Promise<void> {
		const spec = await entry.declaration.start(entry.user, ctx);
		if (spec === undefined) {
			this.entries.delete(entry.key);
			throw new Error("service not available for this user");
		}
		const base = this.deps.policyFor(entry.user);
		if ("reason" in base) throw new Error(base.reason);
		let launchPolicy = base;
		if (this.deps.isolationActive()) {
			const readPaths = [entry.packageDir];
			if (this.deps.managed !== undefined) {
				for (const path of spec.readPaths ?? []) {
					const real = realpathSync(path);
					if (!within(real, entry.packageDir)) {
						const result = validateGrantPath(path, { managed: this.deps.managed, user: entry.user });
						if (!result.ok) throw new Error(`${path}: ${result.reason}`);
						readPaths.push(result.realpath);
					}
				}
			} else {
				readPaths.push(...(spec.readPaths ?? []));
			}
			launchPolicy = { ...base, ro: [...new Set([...base.ro, ...readPaths])].sort() };
		}
		const env = { ...base.env, ...spec.env };
		delete env.SSH_AUTH_SOCK;
		const active = this.deps.isolationActive();
		const launch = active
			? this.deps.launch(launchPolicy, spec.command, spec.args, env)
			: { command: spec.command, args: [...spec.args], env };
		const child = spawn(launch.command, launch.args, {
			env: launch.env,
			cwd: spec.cwd ?? base.home,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		entry.live = this.observe(entry, child);
	}

	private observe(entry: Entry, child: ChildProcessWithoutNullStreams): Live {
		const live: Live = {
			child,
			handles: 0,
			lastTraffic: this.deps.now(),
			stderr: [],
			stdout: new SharedServiceStream(),
			stderrStream: new SharedServiceStream(),
			terminal: false,
			exited: Promise.resolve({ code: null, signal: null }),
		};
		const traffic = (): void => {
			live.lastTraffic = this.deps.now();
			this.armIdle(entry);
		};
		child.stdout.on("data", (chunk: Buffer) => {
			live.stdout.write(new Uint8Array(chunk));
			traffic();
		});
		let pendingStderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			live.stderrStream.write(new Uint8Array(chunk));
			traffic();
			pendingStderr += chunk.toString();
			const lines = pendingStderr.split("\n");
			pendingStderr = lines.pop() ?? "";
			live.stderr.push(...lines.filter((line) => line !== ""));
			if (live.stderr.length > 20) live.stderr.splice(0, live.stderr.length - 20);
		});
		let settle: ((exit: Exit) => void) | undefined;
		const terminal = (exit: Exit, spawnError?: Error): void => {
			if (live.terminal) return;
			live.terminal = true;
			if (spawnError !== undefined) live.stderr.push(spawnError.message);
			live.stdout.end();
			live.stderrStream.end();
			if (pendingStderr !== "") live.stderr.push(pendingStderr);
			if (live.stderr.length > 20) live.stderr.splice(0, live.stderr.length - 20);
			if (entry.live === live) {
				entry.live = undefined;
				clearTimeout(live.timer);
				const stopped = this.closed || !this.declarations.has(entry.slug);
				if (!stopped) {
					const now = this.deps.now();
					entry.failures = entry.failures.filter((at) => now - at <= 300_000);
					entry.failures.push(now);
					entry.lastError = tail(live.stderr);
				}
			}
			settle?.(exit);
		};
		child.once("error", (error) => terminal({ code: null, signal: null }, error));
		child.once("exit", (code, signal) => terminal({ code, signal }));
		live.exited = new Promise<Exit>((resolveExit) => { settle = resolveExit; });
		return live;
	}

	private attach(entry: Entry): ServiceHandle {
		const live = entry.live;
		if (live === undefined) throw serviceError(entry);
		live.handles++;
		live.stdout.setHandles(live.handles);
		live.stderrStream.setHandles(live.handles);
		clearTimeout(live.timer);
		live.lastTraffic = this.deps.now();
		let released = false;
		return {
			stdin: new WritableStream<Uint8Array>({
				write: (chunk) => new Promise<void>((resolveWrite, rejectWrite) => {
					live.lastTraffic = this.deps.now();
					this.armIdle(entry);
					live.child.stdin.write(chunk, (error) => {
						if (error) rejectWrite(error); else resolveWrite();
					});
				}),
				close: async () => { live.child.stdin.end(); },
				abort: async (reason) => { live.child.stdin.destroy(reason as Error); },
			}),
			stdout: live.stdout.stream(),
			stderr: live.stderrStream.stream(),
			exited: live.exited,
			release: () => {
				if (released) return;
				released = true;
				live.handles--;
				live.stdout.setHandles(live.handles);
				live.stderrStream.setHandles(live.handles);
				this.armIdle(entry);
			},
		};
	}

	private armIdle(entry: Entry): void {
		const live = entry.live;
		if (live === undefined) return;
		clearTimeout(live.timer);
		if (live.handles > 0) return;
		const minutes = entry.declaration.idleMinutes ?? 10;
		if (!(minutes > 0)) return;
		const remaining = Math.max(0, minutes * 60_000 - (this.deps.now() - live.lastTraffic));
		live.timer = setTimeout(() => {
			if (entry.live === live && live.handles === 0 && this.deps.now() - live.lastTraffic >= minutes * 60_000) {
				void this.stopEntry(entry);
			} else {
				this.armIdle(entry);
			}
		}, remaining);
		live.timer.unref();
	}

	private async stopEntry(entry: Entry): Promise<void> {
		clearTimeout(entry.live?.timer);
		const starting = entry.starting;
		if (starting !== undefined) await starting.catch(() => {});
		const live = entry.live;
		entry.live = undefined;
		if (entry.failures.length < 3) this.entries.delete(entry.key);
		if (live === undefined) return;
		await new Promise<void>((resolveStop) => {
			if (live.terminal || live.child.exitCode !== null || live.child.signalCode !== null) {
				resolveStop();
				return;
			}
			const timer = setTimeout(() => live.child.kill("SIGKILL"), 2_000);
			timer.unref();
			live.child.once("exit", () => {
				clearTimeout(timer);
				resolveStop();
			});
			live.child.kill("SIGTERM");
		});
	}

	async stopUser(user: string): Promise<void> {
		await Promise.all([...this.entries.values()].filter((entry) => entry.user === user).map((entry) => this.stopEntry(entry)));
	}
	async stopSlug(slug: string): Promise<void> {
		await Promise.all([...this.entries.values()].filter((entry) => entry.slug === slug).map((entry) => this.stopEntry(entry)));
	}
	async stopAll(): Promise<void> {
		this.closed = true;
		await Promise.all([...this.entries.values()].map((entry) => this.stopEntry(entry)));
	}
}

export function servicePackageDirectory(entry: string, packageDir?: string): string {
	return packageDirectory(entry, packageDir);
}
