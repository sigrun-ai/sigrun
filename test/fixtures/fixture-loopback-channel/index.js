/**
 * Test-fixture extension package (gateway Task 1 — the loopback channel):
 * a CONTRIBUTOR-ONLY channel adapter, id `loop`, label `Loop`, the
 * in-memory chat platform the sigrun e2e suites drive.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly (the
 * fixture-providers-only pattern). Contract: the default export is a
 * factory returning `{ name, channels }`.
 *
 * The test controls ride `globalThis` (the fixture-channel pattern —
 * the loader's `import()` and a test's static import may run in
 * different module instances; globalThis is the one shared address
 * space):
 *
 * - `globalThis.__loop` — `{ ctx, sent, edits, typing, commands,
 *   failNext(kind), hangNext(), inbound(event), tap(event) }`, the
 *   handle `bootGateway().loop` returns.
 * - `globalThis.__loopCaps` — the capabilities override (the plan's
 *   default caps when absent).
 * - `globalThis.__loopConfigured` — the `configured()` override
 *   (default `{status: "ready"}`).
 * - `globalThis.__loopClassify` — the `classifyError` override (Task 5:
 *   `failNext("chat_gone")` routes through it; absent → every error
 *   reads transient, the adapter default).
 * - `globalThis.__loopFormat` — the `format` override (Task 5's native
 *   formatter seam; absent → the channel reports `format: "markdown"`
 *   unless `__loopCaps.format` says native).
 */

/** The default capabilities (the plan's table). */
const DEFAULT_CAPS = {
	chatTypes: ["dm", "group", "thread"],
	maxMessageLength: 200,
	format: "markdown",
	edit: { minIntervalMs: 10 },
	buttons: { max: 3 },
	media: ["image", "document"],
	typing: { intervalMs: 50 },
	replyTo: true,
	commandMenu: true,
	promptHint: "Loop renders markdown.",
};

/** The loop handle this module installs on globalThis. */
function makeLoop() {
	const loop = {
		/** The ChannelContext the engine handed `start` (set at start). */
		ctx: undefined,
		/** Every `send`'s message (in order). */
		sent: [],
		/** Every `edit`'s message (in order). */
		edits: [],
		/** Every `typing` call's chat (in order). */
		typing: [],
		/** Every `setCommands` call's list (in order). */
		commands: [],
		/** Fail the NEXT matching adapter call with a synthetic error. */
		failNext(kind) {
			pendingFailure = kind;
		},
		/** Hang the NEXT `receive` resolution (a wedge test seam). */
		hangNext() {
			pendingHang = true;
		},
		/**
		 * Deliver one inbound event to the engine (resolves with the
		 * receive outcome; rejects when the engine failed).
		 */
		async inbound(event) {
			if (loop.ctx === undefined) {
				throw new Error("loop: not started (no ChannelContext yet)");
			}
			if (pendingHang) {
				pendingHang = false;
				await new Promise(() => {});
			}
			return loop.ctx.receive(event);
		},
		/** Tap a button action through the engine. */
		async tap(event) {
			if (loop.ctx === undefined) {
				throw new Error("loop: not started (no ChannelContext yet)");
			}
			return loop.ctx.action(event);
		},
	};
	return loop;
}

let pendingFailure = undefined;
let pendingHang = false;

/** The installed handle (one per module instance; tests read globalThis). */
const loop = makeLoop();
globalThis.__loop = loop;

/** Fail the next `kind` call when one is pending (the failNext seam). */
function maybeFail(kind) {
	if (pendingFailure === kind) {
		pendingFailure = undefined;
		const error = new Error(`loop: synthetic ${kind} failure`);
		// The classification marker the classifyError override reads
		// (chat_gone/permanent); absent marker → transient (the default).
		error.kind = kind;
		throw error;
	}
}

export default function createFixtureLoopbackChannel() {
	return {
		name: "fixture-loopback-channel",
		channels: [
			{
				id: "loop",
				label: "Loop",
				get capabilities() {
					return globalThis.__loopCaps ?? DEFAULT_CAPS;
				},
				configured() {
					return globalThis.__loopConfigured ?? { status: "ready" };
				},
				start: async (ctx) => {
					// failNext("start") rejects the next start attempt (Task 2's
					// supervision round trip: a rejected start enters backoff).
					maybeFail("start");
					loop.ctx = ctx;
				},
				send: async (message) => {
					maybeFail("send");
					loop.sent.push(message);
					return { messageIds: [`loop-${loop.sent.length}`] };
				},
				edit: async (ref, message) => {
					maybeFail("edit");
					loop.edits.push({ ref, message });
				},
				delete: async (ref) => {
					maybeFail("delete");
				},
				typing: async (chat) => {
					loop.typing.push(chat);
				},
				setCommands: async (commands) => {
					loop.commands.push(commands);
				},
				// Task 5: the classification seam. The override wins when set
				// (a marker-bearing error reads its kind); everything else is
				// transient — the adapter contract's default.
				classifyError: (error) => {
					const override = globalThis.__loopClassify;
					if (override !== undefined) return override(error);
					const kind = error && typeof error === "object" ? error.kind : undefined;
					return kind === "permanent" || kind === "chat_gone" ? kind : "transient";
				},
				format: (markdown) => {
					const override = globalThis.__loopFormat;
					return override === undefined ? markdown : override(markdown);
				},
			},
		],
	};
}
