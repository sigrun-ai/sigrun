// A packages-dir fixture whose manifest declares NO runtime dependencies
// while importing a HOST module bare (`@earendil-works/pi-ai/models`) —
// the provider-plugins dependency posture: the host ships pi-ai, npm never
// installs a dependency's devDependencies, so the packages dir must link
// the host's own copy for this import to resolve (ensureHostModuleLinks).
import { createProvider } from "@earendil-works/pi-ai/models";

export const hostResolved = typeof createProvider === "function";

export default function fixtureHostmod() {
	return { name: "fixture-pkg-hostmod", providers: [], hostResolved };
}
