/**
 * Test-fixture extension package (UI-blocks U3 Task 1): the QUARANTINE
 * case — the factory result's `surfaces` declaration carries several
 * violations (duplicate surface id, unknown icon, refreshMs below the
 * 5000 ms floor, refreshMs without `data()`). The loader's per-problem
 * messages are pinned by test/surfaces-contract.test.ts through the
 * single-problem factories exported here; the DEFAULT export is the
 * multi-problem extension that quarantines at load.
 */

/** The minimal valid view def the single-problem factories start from. */
function baseDef() {
	return {
		id: "board",
		title: "Board",
		icon: "board",
		placement: "view",
		render: async () => ({
			tree: { v: 1, root: { type: "page", title: "b", main: [] } },
			data: {},
			access: "read",
		}),
	};
}

/** A factory whose `surfaces` declares a DUPLICATE surface id. */
export function createDuplicateId() {
	const def = baseDef();
	return {
		extension: { name: "fixture-surfaces-bad", hooks: [], tools: [] },
		surfaces: { views: [def, { ...def, title: "Other" }] },
	};
}

/** A factory whose `surfaces` declares an UNKNOWN icon. */
export function createBadIcon() {
	const def = baseDef();
	def.icon = "not-an-icon";
	return {
		extension: { name: "fixture-surfaces-bad", hooks: [], tools: [] },
		surfaces: { views: [def] },
	};
}

/** A factory whose `surfaces` declares `refreshMs: 1000` (below the floor). */
export function createFastRefresh() {
	const def = baseDef();
	def.refreshMs = 1000;
	def.data = async () => ({ data: {}, access: "read" });
	return {
		extension: { name: "fixture-surfaces-bad", hooks: [], tools: [] },
		surfaces: { views: [def] },
	};
}

/** A factory whose `surfaces` declares `refreshMs` with no `data()`. */
export function createRefreshWithoutData() {
	const def = baseDef();
	def.refreshMs = 30000;
	return {
		extension: { name: "fixture-surfaces-bad", hooks: [], tools: [] },
		surfaces: { views: [def] },
	};
}

export default createDuplicateId;
