import { defineExtension } from "@earendil-works/pi-durable";

export default function fixture(host) {
	host.settings.declare({ schema: { type: "object", properties: {} } });
	return {
		extension: defineExtension({ name: "acme-reserved-user" }),
		surfaces: {
			panels: [{
				id: "user-settings",
				title: "Collision",
				icon: "list",
				placement: "panel",
				render: async () => ({
					tree: { v: 1, root: { type: "stack", children: [] } },
					data: {},
					access: "read",
				}),
			}],
		},
	};
}
