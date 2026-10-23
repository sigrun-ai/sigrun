/**
 * Test-fixture extension package (gateway C1): a MALFORMED channel
 * declaration — the channel's `send` is a string, not a function. The
 * loader must quarantine the extension with an error naming the
 * channel ("loop") and the field, exactly like a malformed notifier.
 */

/** Default export: factory returning a malformed channel contribution. */
export default function createFixtureChannelBad() {
	return {
		name: "fixture-channel-bad",
		channels: [
			{
				id: "loop",
				label: "Broken Loopback",
				capabilities: {
					chatTypes: ["dm"],
					maxMessageLength: 4096,
					format: "markdown",
				},
				configured: () => ({ status: "ready" }),
				start: async () => {},
				send: "https://platform.example/send",
			},
		],
	};
}
