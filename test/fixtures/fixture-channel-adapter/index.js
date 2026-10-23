/**
 * Test-fixture extension package (gateway C1): a CONTRIBUTOR-ONLY channel
 * adapter — the factory result carries `name` + `channels` (one channel
 * with id "loop") with NO `extension`, the minimal adapter shape (a chat
 * platform adapter needs no pi-durable surface of its own; the gateway
 * engine owns the pi-durable side). The loader must load it (not
 * quarantine) and boot must retain the binding under the slug.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly (the
 * fixture-providers-only pattern). Contract: the default export is a
 * factory returning `{ name, channels }`.
 */

/** Default export: factory returning a contributor-only channel adapter. */
export default function createFixtureChannelAdapter() {
	return {
		name: "fixture-channel-adapter",
		channels: [
			{
				id: "loop",
				label: "Loopback",
				capabilities: {
					chatTypes: ["dm", "group"],
					maxMessageLength: 4096,
					format: "markdown",
				},
				configured: () => ({ status: "ready" }),
				start: async () => {},
				send: async () => ({ messageIds: ["fixture-1"] }),
			},
		],
	};
}
