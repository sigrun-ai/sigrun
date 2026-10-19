/**
 * The conversation list tree (Task B1, UI refresh): sidebar shaping —
 * fork nesting, recency ordering, pinned grouping and age rendering.
 *
 * PURE module: no imports at all (test/views-purity.test.ts enforces
 * this). `ListRow` is structural — both clients' wire row types fit —
 * and the only fields read are the ones the list endpoint ships.
 */

export interface ListRow {
	readonly id: number;
	readonly name?: string;
	readonly lastActivityAt?: string;
	readonly parent?: { readonly id: number };
	readonly archived: boolean;
	readonly pinned: boolean;
}

export interface TreeNode<R extends ListRow> {
	readonly row: R;
	readonly children: readonly TreeNode<R>[];
	/** Max epoch ms over the whole subtree; 0 when nothing was ever used. */
	readonly newestActivity: number;
}

export type AgeGroup = "Pinned" | "Today" | "Yesterday" | "Earlier";

/** Sort: newest first, ties by id descending. */
function byRecency<R extends ListRow>(a: TreeNode<R>, b: TreeNode<R>): number {
	return b.newestActivity - a.newestActivity || b.row.id - a.row.id;
}

/** Assembly-time node: children attach before the readonly tree is built. */
interface BuilderNode<R extends ListRow> {
	row: R;
	children: BuilderNode<R>[];
}

/** Epoch ms of a row's activity stamp; 0 when absent or unparsable. */
function epoch(iso: string | undefined): number {
	if (iso === undefined) return 0;
	const parsed = Date.parse(iso);
	return Number.isNaN(parsed) ? 0 : parsed;
}

export function buildConversationTree<R extends ListRow>(
	rows: readonly R[],
	options: { includeArchived: boolean },
): TreeNode<R>[] {
	const nodes = new Map<number, BuilderNode<R>>();
	for (const row of rows) {
		// `parent` is fork lineage — an ancestor by construction (set once,
		// at fork time), so the resulting forest is acyclic.
		if (options.includeArchived || !row.archived) {
			nodes.set(row.id, { row, children: [] });
		}
	}

	const roots: BuilderNode<R>[] = [];
	for (const node of nodes.values()) {
		const parent = node.row.parent;
		const parentNode = parent === undefined ? undefined : nodes.get(parent.id);
		if (parentNode === undefined || parentNode === node) {
			roots.push(node);
		} else {
			parentNode.children.push(node);
		}
	}

	const toNode = (node: BuilderNode<R>): TreeNode<R> => {
		const children = node.children.map(toNode).sort(byRecency);
		const own = epoch(node.row.lastActivityAt);
		const newestActivity = children.reduce(
			(max, child) => Math.max(max, child.newestActivity),
			own,
		);
		return { row: node.row, children, newestActivity };
	};

	return roots
		.map(toNode)
		.sort((a, b) => Number(b.row.pinned) - Number(a.row.pinned) || byRecency(a, b));
}

/** Local-calendar-day distance between two instants. */
function dayDistance(then: number, now: Date): number {
	const midnight = (value: number | Date): number => {
		const date = new Date(value);
		return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	};
	// `round` absorbs DST's 23/25-hour days around the midnight anchor.
	return Math.round((midnight(now) - midnight(then)) / 86_400_000);
}

export function ageGroup(node: TreeNode<ListRow>, now: Date): AgeGroup {
	if (node.row.pinned) return "Pinned";
	const days = dayDistance(node.newestActivity, now);
	if (days <= 0) return "Today";
	if (days === 1) return "Yesterday";
	return "Earlier";
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function formatAge(iso: string | undefined, now: Date): string {
	if (iso === undefined) return "";
	const at = Date.parse(iso);
	if (Number.isNaN(at)) return "";
	const age = now.getTime() - at;
	if (age < MINUTE) return "now";
	if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
	if (age < DAY) return `${Math.floor(age / HOUR)}h`;
	if (age < 7 * DAY) return `${Math.floor(age / DAY)}d`;
	return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(at);
}

export function displayName(row: ListRow): string {
	const flattened = row.name?.replace(/[\r\n]+/g, " ").trim();
	return flattened === undefined || flattened.length === 0
		? "New conversation"
		: flattened;
}
