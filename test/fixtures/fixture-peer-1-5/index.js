/**
 * Test-fixture extension whose peer range (~1.5.0) admits the running
 * 1.5.0 host (Task 6 / spec D3). A trivial factory — the positive control
 * proving the pre-import guard only quarantines excluding ranges.
 */

export default function createPeer15() {
	return {
		extension: { name: "fixture-peer-1-5", hooks: [], tools: [], sections: [] },
	};
}
