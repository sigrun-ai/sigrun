/**
 * Test-fixture extension package (gateway C1): the SECOND of two
 * channel-id colliding adapters — declares the SAME channel id "loop"
 * as fixture-channel-adapter (any valid shape suffices; the collision
 * is keyed by id alone). The loader must quarantine THIS load naming
 * both adapters; the first stays bound.
 */

/** Default export: factory returning a contributor-only channel adapter. */
export default function createFixtureChannelTwin() {
	return {
		name: "fixture-channel-twin",
		channels: [
			{
				id: "loop",
				label: "Twin Loopback",
				capabilities: {
					chatTypes: ["dm"],
					maxMessageLength: 1024,
					format: "plain",
				},
				configured: () => ({ status: "not_configured" }),
				start: async () => {},
				send: async () => ({ messageIds: [] }),
			},
		],
	};
}
