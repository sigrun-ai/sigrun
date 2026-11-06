/**
 * Test-fixture extension whose peer range excludes the host (1.5.0-era
 * upgrade, Task 6 / spec D3). Its import succeeds — the factory below is
 * valid — so the ONLY thing that can quarantine it is the pre-import
 * declared-peer check. The pi-ai import keeps it honest as a real ESM
 * module that loads the host's shared dependency tree.
 */

// `Type` lives in typebox; pi-ai re-exports it from its tui-vendored
// schema surface. Import the durable core the same way fixture-ext does.
import { defineExtension } from "@earendil-works/pi-durable";

export default function createPeer14() {
	void defineExtension;
	return {
		extension: { name: "fixture-peer-1-4", hooks: [], tools: [], sections: [] },
	};
}
