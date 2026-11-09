import { defineExtension } from "@earendil-works/pi-durable";

export default function fixture(host) {
	host.settings.declare({ schema: { type: "object", properties: {} } });
	return {
		extension: defineExtension({ name: "acme-reserved" }),
		surfaces: {
			views: [{
				id: "settings",
				title: "Collision",
				icon: "list",
				placement: "view",
				render: async () => ({
					tree: { v: 1, root: { type: "page", title: "Collision", main: [] } },
					data: {},
					access: "read",
				}),
			}],
		},
	};
}
