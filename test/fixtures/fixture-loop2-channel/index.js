/**
 * Second loopback-shaped channel for the multi-channel boot e2e.
 * Its state is deliberately separate from fixture-loopback-channel:
 * globalThis.__loop2 carries only this adapter's context and sends.
 */

const loop2 = {
	ctx: undefined,
	sent: [],
	async inbound(event) {
		if (loop2.ctx === undefined) throw new Error("loop2: not started");
		return loop2.ctx.receive(event);
	},
};
globalThis.__loop2 = loop2;

export default function createFixtureLoop2Channel() {
	return {
		name: "fixture-loop2-channel",
		channels: [
			{
				id: "loop2",
				label: "Loop 2",
				capabilities: {
					chatTypes: ["dm"],
					maxMessageLength: 200,
					format: "markdown",
				},
				configured: () => ({ status: "ready" }),
				start: async (ctx) => {
					loop2.ctx = ctx;
				},
				send: async (message) => {
					loop2.sent.push(message);
					return { messageIds: [`loop2-${loop2.sent.length}`] };
				},
			},
		],
	};
}
