import { defineExtension } from "@earendil-works/pi-durable";

export default function createQuarantinedUserTools() {
	return {
		perUserTools: true,
		extension: defineExtension({ name: "acme", sections: [null] }),
	};
}
