/**
 * Settings round-trip fixture (A6): declares whatever schema the test put
 * on `globalThis.__acmeRoundtripSchema` before booting (the loader imports
 * this module itself, so the schema rides a process global rather than a
 * module export).
 */
import { defineExtension } from "@earendil-works/pi-durable";

export default function fixture(host) {
	const schema = globalThis.__acmeRoundtripSchema;
	if (schema !== undefined) host.settings.declare({ schema });
	return {
		extension: defineExtension({ name: "acme-roundtrip" }),
	};
}
