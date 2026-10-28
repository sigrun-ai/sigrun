/** Observe one self-service settings write through the real loader path. */
import { defineExtension } from "@earendil-works/pi-durable";

export const received = [];

export function reset() {
	received.length = 0;
}

export default function createMeSettingsObserver(host) {
	return {
		extension: defineExtension({ name: "acme-settings-observer" }),
		async onSettingsChanged(keys, user) {
			received.push({
				keys: [...keys],
				user,
				settings: await host.stores.user(user).settings.get(),
			});
		},
	};
}
