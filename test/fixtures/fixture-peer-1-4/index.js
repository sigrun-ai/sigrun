/**
 * Test-fixture extension whose peer range excludes the host (1.5.0-era
 * upgrade, Task 6 / spec D3). The module-level import below is the
 * DISCRIMINATING point: pi-ai 1.5.0 exports no `Type`, so evaluating this
 * module throws a SyntaxError. The quarantine outcome therefore pins the
 * check's ORDER — if checkDeclaredPeers runs BEFORE the import, the
 * outcome names the peer-range reason; if it ran after, the import error
 * would surface instead.
 */

import { Type } from "@earendil-works/pi-ai";

export default function createPeer14() {
	void Type;
	return {
		extension: { name: "fixture-peer-1-4", hooks: [], tools: [], sections: [] },
	};
}
