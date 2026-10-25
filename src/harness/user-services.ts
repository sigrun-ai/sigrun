/** Core-owned per-user service processes. Workers and services are siblings. */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { Writable } from "node:stream";
import type { HandlerContext, ServiceHandle, UserService } from "../extension.js";
import type { ManagedPaths } from "../sandbox/grants.js";
import { validateGrantPath } from "../sandbox/grants.js";
import type { LaunchService } from "../sandbox/launch.js";
import type { UserPolicy } from "../sandbox/policy.js";

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
	stdout: ReadableStream<Uint8Array>;
	stderrStream: ReadableStream<Uint8Array>;
	stdoutController: ReadableStreamDefaultController<Uint8Array>;
	stderrController: ReadableStreamDefaultController<Uint8Array>;
	stdoutFactory: () => ReadableStream<Uint8Array>;
	stderrFactory: () => ReadableStream<Uint8Array>;
};
type Entry = {
	key: string;
	slug: string;
	name: string;
	user: string;
	declaration: UserService;
	packageDir: string;
	starting?: Promise<ServiceHandle>;
	live?: Live;
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
			if (entry.slug === slug && entry.user === user && entry.live === undefined) {
				this.entries.delete(entry.key);
			}
		}
	}

	statuses(): ServiceStatus[] {
		return [...this.entries.values()].map((entry) => {
			const live = entry.live;
			return {
				slug: entry.slug,
				name: entry.name,
				user: entry.user,
				state: live === undefined ? "failed" : live.handles === 0 ? "idle" : "running",
				...(live === undefined && entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
			};
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
			};
			this.entries.set(key, entry);
		}
		if (entry.live === undefined && entry.failures.length >= 3) throw serviceError(entry);
		if (entry.live === undefined && entry.starting === undefined) {
			entry.starting = this.start(entry, ctx).finally(() => { entry!.starting = undefined; });
		}
		return entry.starting ?? this.attach(entry);
	}

	private async start(entry: Entry, ctx: HandlerContext): Promise<ServiceHandle> {
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
		return this.attach(entry);
	}

	private observe(entry: Entry, child: ChildProcessWithoutNullStreams): Live {
			let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
			let stderrController!: ReadableStreamDefaultController<Uint8Array>;
		const live: Live = {
			child,
			handles: 0,
			lastTraffic: this.deps.now(),
			stderr: [],
			stdout: new ReadableStream<Uint8Array>({ start(controller) { stdoutController = controller; } }),
			stderrStream: new ReadableStream<Uint8Array>({ start(controller) { stderrController = controller; } }),
			// Multiple handles share the underlying stream; each attachment gets
			// its own unlocked reader over the same queued chunks.
			stdoutFactory: undefined!,
			stderrFactory: undefined!,
			// SAFETY: the stream constructors run synchronously above; both fields
			// are assigned from their start callbacks before observe returns.
			stdoutController: undefined!,
			stderrController: undefined!,
			exited: Promise.resolve({ code: null, signal: null }),
		};
		const traffic = (): void => {
			live.lastTraffic = this.deps.now();
			this.armIdle(entry);
		};
		live.stdoutController = stdoutController;
		live.stderrController = stderrController;
		live.stdoutFactory = () => new ReadableStream<Uint8Array>({
			start(controller) {
				const onData = (chunk: Buffer): void => controller.enqueue(new Uint8Array(chunk));
				child.stdout.on("data", onData);
				child.stdout.once("end", () => controller.close());
			},
		});
		live.stderrFactory = () => new ReadableStream<Uint8Array>({
			start(controller) {
				child.stderr.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
				child.stderr.once("end", () => controller.close());
			},
		});
		child.stdout.on("data", (chunk: Buffer) => { stdoutController.enqueue(new Uint8Array(chunk)); traffic(); });
		let pendingStderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			traffic();
			pendingStderr += chunk.toString();
			const lines = pendingStderr.split("\n");
			pendingStderr = lines.pop() ?? "";
			live.stderr.push(...lines.filter((line) => line !== ""));
			if (live.stderr.length > 20) live.stderr.splice(0, live.stderr.length - 20);
		});
		live.exited = new Promise<Exit>((resolveExit) => {
			child.once("error", () => {
				live.stderr.push("process spawn failed");
			});
			child.once("exit", (code, signal) => {
				stdoutController.close();
				stderrController.close();
				if (pendingStderr !== "") live.stderr.push(pendingStderr);
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
				resolveExit({ code, signal });
			});
		});
		return live;
	}

	private attach(entry: Entry): ServiceHandle {
		const live = entry.live;
		if (live === undefined) throw serviceError(entry);
		live.handles++;
		clearTimeout(live.timer);
		live.lastTraffic = this.deps.now();
		let released = false;
		return {
			stdin: Writable.toWeb(live.child.stdin) as WritableStream<Uint8Array>,
			stdout: live.stdoutFactory(),
			stderr: live.stderrFactory(),
			exited: live.exited,
			release: () => {
				if (released) return;
				released = true;
				live.handles--;
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
			console.error("IDLE_DEBUG", this.deps.now(), live.lastTraffic, minutes);
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
		entry.starting = undefined;
		const live = entry.live;
		entry.live = undefined;
		this.entries.delete(entry.key);
		if (live === undefined) return;
		await new Promise<void>((resolveStop) => {
			if (live.child.exitCode !== null || live.child.signalCode !== null) {
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
