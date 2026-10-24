/**
 * `validateTree` (spec §14.2): every error with its JSON path and a
 * plain message.
 *
 * Two passes:
 * 1. The compiled typebox validators (`schema.ts`) check each node's
 *    shape: the walk descends the tree, finds every block, field,
 *    action, button and card template, and runs the matching compiled
 *    validator against it. Instance paths (relative to the node) join
 *    the walk's path, so one broken block is one precise error
 *    (`root.main[2].text`), never a union mismatch per sibling.
 * 2. The same walk checks what schemas cannot express: placements
 *    (§5.7), the literal-ness of structural props (§4.2), handler names
 *    (§6.1), relative bindings outside item templates (§4.2), ids
 *    (§4.1), `turn` outside chat (§6.2), `open` schemes (§6.1), image
 *    sources (§11.1), limits (§4.5), and the ambient one-line rule
 *    (§9.2).
 */

import { BLOCK_SET_VERSION, type Placement, type Tree } from "@sigrun/shared/blocks";
import {
	ACTION_BUTTON_VALIDATOR,
	ACTION_VALIDATOR,
	BLOCK_VALIDATORS,
	CARD_VALIDATOR,
	FIELD_VALIDATORS,
} from "./schema.js";
import { PLACEMENT_RULES } from "./placements.js";
import { LIMITS, jsonBytes } from "./limits.js";
import { checkImageSource } from "./images.js";

export { PLACEMENT_RULES } from "./placements.js";
export { LIMITS } from "./limits.js";
export type { PlacementRule } from "./placements.js";
export type { PlacementLimits } from "./limits.js";

/** The placements the block set defines (spec §3). */
export const VALID_PLACEMENTS: readonly Placement[] = [
	"view",
	"panel",
	"settings",
	"chat",
	"interaction",
	"ambient",
];

/** One validation error: where and what (spec §14.2). */
export interface ValidationError {
	path: string;
	message: string;
}

/** Options for `validateTree`. */
export interface ValidateOptions {
	placement: Placement;
	/**
	 * The surface's `actions` map keys (spec §6.1); when given, every
	 * handler-name prop must be in it. When omitted (chat), handler
	 * names are free labels.
	 */
	handlers?: ReadonlySet<string>;
	/** The server's block-set version; a mismatched tree is rejected (§4.4). */
	serverV?: number;
	/** For ambient trees: which `place` renders this body (§9.2 one-line rule). */
	ambientPlace?: "status" | "footer" | "panel";
}

/** The ok result of `validateTree`: the tree, narrowed to the wire type. */
export interface ValidateOk {
	ok: true;
	tree: Tree;
}

/** The failure result: every error found, each with its path. */
export interface ValidateErr {
	ok: false;
	errors: ValidationError[];
}

/** `validateTree`'s result. */
export type ValidateResult = ValidateOk | ValidateErr;

/** The result of `validateData`. */
export type ValidateDataResult = { ok: true } | { ok: false; errors: ValidationError[] };

// ─── structural helpers ───────────────────────────────────────────────────

/** A record viewed structurally (the walk's input is wire JSON). */
type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBinding(value: unknown): value is { $: string } {
	return isRec(value) && typeof value.$ === "string";
}

/** Path segment join: `root` + `main` → `root.main`, + `2` → `root.main[2]`. */
function joinPath(base: string, key: string): string {
	return /^\d+$/.test(key) ? `${base}[${key}]` : `${base}.${key}`;
}

/** Handler-name props across the block set (spec §6.1). */
const HANDLER_PROPS = ["onMove", "onCheck", "onExpand", "onResize", "onCreate", "onSubmit", "onUpload"] as const;

/** Block types the ambient one-line rule treats as line-level (§9.2). */
const AMBIENT_LINE_BLOCKS = new Set(["markdown", "stat", "meter", "log"]);

/** Structural props that must be literals, per block type (spec §4.2). */

/** Structural props that must be literals, per block type (spec §4.2). */
const STRUCTURAL_LITERALS: Readonly<Record<string, readonly string[]>> = {
	page: [],
	stack: [],
	columns: [],
	grid: [],
	section: [],
	markdown: [],
	fields: [],
	stat: [],
	callout: [],
	image: [],
	chart: [],
	meter: [],
	log: [],
	tree: [],
	diff: [],
	details: [],
	collection: ["display", "groupBy", "groups", "reorder", "select", "columns", "onMove", "onCheck"],
	form: ["mode", "onSubmit"],
};

/** A field's `name` is always structural (§4.2). */
const FIELD_STRUCTURAL_LITERALS: readonly string[] = ["name"];

// ─── the walk ─────────────────────────────────────────────────────────────

/** Context carried down the walk. */
interface WalkCtx {
	placement: Placement;
	handlers?: ReadonlySet<string>;
	/** Relative `./` bindings are legal only inside this subtree. */
	itemTemplate: boolean;
	/** For ambient trees: which `place` renders this body (§9.2). */
	ambientPlace?: "status" | "footer" | "panel";
	errors: ValidationError[];
	/** Ids seen so far, for uniqueness (§4.1). */
	ids: Map<string, string>;
}

function push(ctx: WalkCtx, path: string, message: string): void {
	ctx.errors.push({ path, message });
}

/** Convert a JSON-pointer instance path to the spec's dot shape ("/text" → ".text"). */
function relPath(instancePath: string): string {
	return instancePath
		.split("/")
		.filter((s) => s.length > 0)
		.map((s) => (/^\d+$/.test(s) ? `[${s}]` : `.${s}`))
		.join("");
}

/** Append a node's compiled-validator errors, prefixed with its walk path. */
function checkSchema(
	ctx: WalkCtx,
	validator: { Errors(value: unknown): { instancePath: string; message?: string }[] },
	node: unknown,
	path: string,
): void {
	for (const raw of validator.Errors(node)) {
		const rel = relPath(raw.instancePath);
		const message = raw.message ?? "invalid value";
		// Name the prop the error sits on ("icon: must be equal to one of
		// the allowed values") so the message reads at the path it lands at.
		const segments = raw.instancePath.split("/").filter((s) => s.length > 0);
		const lastProp = [...segments].reverse().find((s) => !/^\d+$/.test(s));
		push(ctx, `${path}${rel}`, lastProp ? `${lastProp}: ${message}` : message);
	}
}

/** Check a handler-name prop: literal, and in the handlers set when given. */
function checkHandler(ctx: WalkCtx, path: string, name: unknown, prop: string): void {
	if (name === undefined || name === null) return;
	if (isRec(name)) {
		push(ctx, path, `${prop} must be a literal (a handler name), not a binding`);
		return;
	}
	if (typeof name !== "string") return; // the schema already flagged it
	if (ctx.handlers && !ctx.handlers.has(name)) {
		push(ctx, path, `no handler named ${name}`);
	}
}

/** An `Action` object: shape via its validator, then name/turn/url rules. */
function checkAction(ctx: WalkCtx, action: unknown, path: string): void {
	if (!isRec(action)) return;
	checkSchema(ctx, ACTION_VALIDATOR, action, path);
	const type = action.type;
	if (type === "submit" || type === "move" || type === "edit") {
		if (isRec(action.name)) {
			push(ctx, joinPath(path, "name"), "action name must be a literal");
		} else if (typeof action.name === "string" && ctx.handlers && !ctx.handlers.has(action.name)) {
			push(ctx, joinPath(path, "name"), `no handler named ${action.name}`);
		}
	}
	if (ctx.placement !== "chat" && action.turn === true) {
		push(ctx, joinPath(path, "turn"), "`turn` is valid only in the chat placement");
	}
	if (type === "open" && typeof action.url === "string" && !/^(https?:|mailto:)/.test(action.url)) {
		push(
			ctx,
			joinPath(path, "url"),
			`open url must be https:, http: or mailto: (got "${action.url.slice(0, 40)}")`,
		);
	}
}

/** An action-button list (`page.actions`, `callout.actions`, card `actions`). */
function checkActionButtons(ctx: WalkCtx, buttons: unknown, path: string): void {
	if (!Array.isArray(buttons)) return;
	buttons.forEach((button, i) => {
		if (!isRec(button)) return;
		const bPath = `${path}[${i}]`;
		checkSchema(ctx, ACTION_BUTTON_VALIDATOR, button, bPath);
		if (isBinding(button.label)) checkBinding(ctx, button.label, joinPath(bPath, "label"));
		checkAction(ctx, button.action, joinPath(bPath, "action"));
	});
}

/** Relative `./` bindings are legal only inside a card template (§4.2). */
function checkBinding(ctx: WalkCtx, binding: { $: string }, path: string): void {
	if (!ctx.itemTemplate && binding.$.startsWith("./")) {
		push(
			ctx,
			joinPath(path, "$"),
			`relative binding "${binding.$}" is only valid inside a collection item template`,
		);
	}
}

/**
 * Any relative `./` binding on this node (§4.2): every prop value is
 * scanned — the binding-only props (`items`, `lines`, `nodes`, `rows`,
 * `series[].data`, `submitLabel`, `copy.text`) bind just like the
 * bindable literals, so a hardcoded prop list would miss them. Absolute
 * `/` bindings stay legal everywhere; relative ones only inside item
 * templates. `skip` names props whose own walk already reported (the
 * structural literals above carry their more precise message).
 */
function checkNodeRelativeBindings(ctx: WalkCtx, node: Rec, path: string, skip: ReadonlySet<string>): void {
	if (ctx.itemTemplate) return;
	for (const [prop, value] of Object.entries(node)) {
		if (skip.has(prop)) continue;
		if (isBinding(value)) {
			checkBinding(ctx, value, joinPath(path, prop));
		} else if (Array.isArray(value)) {
			// rows, series, meta, badges: bindings nested one level in
			// literal arrays (e.g. `series[].data`)
			value.forEach((element, i) => {
				if (isBinding(element)) {
					checkBinding(ctx, element, joinPath(joinPath(path, prop), String(i)));
				} else if (isRec(element)) {
					for (const [k, v] of Object.entries(element)) {
						if (isBinding(v)) {
							checkBinding(ctx, v, joinPath(joinPath(joinPath(path, prop), String(i)), k));
					}
				}
				}
			});
		}
	}
}

/** One field node (spec §5.6). `path` is the field's own path. */
function checkField(ctx: WalkCtx, node: Rec, path: string): void {
	const type = node.type;
	if (typeof type !== "string") {
		// `type` is a structural literal (§4.2); a missing or bound type is
		// a soundness hole, never a silent pass
		push(ctx, joinPath(path, "type"), `field type must be a literal string`);
		return;
	}
	const rules = PLACEMENT_RULES[ctx.placement];

	// placement: allowed field types (forms only exist where forms exist)
	if (!rules.fields.has(type)) {
		push(ctx, path, `${type} field is not allowed in ${ctx.placement}`);
		return;
	}

	// schema
	const validator = FIELD_VALIDATORS.get(type);
	if (validator) checkSchema(ctx, validator, node, path);

	// structural literals
	for (const prop of FIELD_STRUCTURAL_LITERALS) {
		if (isBinding(node[prop])) {
			push(ctx, joinPath(path, prop), `field name must be a literal, not a binding`);
		}
	}

	// bindable props: every relative `./` binding on the field (§4.2);
	// the structural-literal props above already carry their message
	checkNodeRelativeBindings(
		ctx,
		node,
		path,
		new Set([...FIELD_STRUCTURAL_LITERALS, "type"]),
	);

	// handler names
	if (node.onUpload !== undefined) {
		checkHandler(ctx, joinPath(path, "onUpload"), node.onUpload, "onUpload");
	}

	// list fields recurse into one entry's field
	if (type === "list" && isRec(node.item)) {
		checkField(ctx, node.item, joinPath(path, "item"));
	}
}

/** A card template (spec §5.5.1): relative bindings are legal throughout. */
function checkCard(ctx: WalkCtx, card: unknown, path: string): void {
	if (!isRec(card)) return;
	checkSchema(ctx, CARD_VALIDATOR, card, path);
	if (Array.isArray(card.actions)) {
		checkActionButtons(ctx, card.actions, joinPath(path, "actions"));
	}
}

/**
 * One block node. `path` is the node's own path; `rootDepth` marks the
 * tree's root block (root constraints apply there only).
 */
function checkBlock(ctx: WalkCtx, node: Rec, path: string, rootDepth: boolean): void {
	const type = node.type;
	if (typeof type !== "string") {
		// `type` is a structural literal (§4.2); a missing or bound type is
		// a soundness hole, never a silent pass
		push(ctx, joinPath(path, "type"), `block type must be a literal string`);
		return;
	}
	const rules = PLACEMENT_RULES[ctx.placement];

	// unknown block types (§4.4) first: `carousel` is not a block of this
	// set at all, so its error names the type, at the type prop's path
	if (!BLOCK_VALIDATORS.has(type)) {
		if (FIELD_VALIDATORS.has(type)) {
			push(
				ctx,
				joinPath(path, "type"),
				`a ${type} field is not a block; fields belong inside a form`,
			);
		} else {
			push(ctx, joinPath(path, "type"), `unknown block type "${type}"`);
		}
		return;
	}

	// placement: allowed blocks
	if (!rules.blocks.has(type)) {
		push(ctx, path, `${type} block is not allowed in ${ctx.placement}`);
		return; // an illegal block's children are noise
	}

	// root constraints
	if (rootDepth && rules.rootBlock && type !== rules.rootBlock) {
		push(ctx, path, `the root block of a ${ctx.placement} surface must be ${rules.rootBlock}`);
	}
	if (type === "page" && !rules.pageSidebar && node.sidebar !== undefined) {
		push(ctx, joinPath(path, "sidebar"), `page.sidebar is not allowed in ${ctx.placement}`);
	}

	// structural literals (§4.2): checked before the schema so the
	// precise "must be a literal" message is the first error at its path
	for (const prop of STRUCTURAL_LITERALS[type] ?? []) {
		if (isBinding(node[prop])) {
			const isHandler = (HANDLER_PROPS as readonly string[]).includes(prop);
			push(
				ctx,
				joinPath(path, prop),
				isHandler
					? `${prop} must be a literal (a handler name), not a binding`
					: `${prop} must be a literal, not a binding`,
			);
		}
	}

	// schema
	const validator = BLOCK_VALIDATORS.get(type);
	if (validator) checkSchema(ctx, validator, node, path);

	// collection-specific rules
	if (type === "collection") {
		// Controller ruling (2026-10-24): bindings are OUT of ambient
		// placement — the ambient envelope carries no data document, so a
		// bound `items` has nothing to resolve against. Literal rows only.
		// (Reversible: extending the envelope with a data slot remains open.)
		if (ctx.placement === "ambient" && isBinding(node.items)) {
			push(
				ctx,
				joinPath(path, "items"),
				"ambient collections carry literal rows (items must not be a binding)",
			);
		}
		const display = node.display;
		if (
			typeof display === "string" &&
			rules.collectionDisplays &&
			!rules.collectionDisplays.includes(display)
		) {
			push(
				ctx,
				joinPath(path, "display"),
				`collection display ${display} is not allowed in ${ctx.placement} (allowed: ${rules.collectionDisplays.join(", ")})`,
			);
		}
		// reorder requires onMove (spec §5.5)
		if (node.reorder !== undefined && node.onMove === undefined) {
			push(ctx, joinPath(path, "reorder"), "`reorder` requires `onMove`");
		}
		// the card template: relative bindings legal inside it
		if (isRec(node.item)) {
			checkCard({ ...ctx, itemTemplate: true }, node.item, joinPath(path, "item"));
		}
		// bulk actions carry small forms (§5.5); their subtrees are NOT item
		// templates, so relative bindings inside them fail — correct.
		if (Array.isArray(node.bulkActions)) {
			node.bulkActions.forEach((bulk, i) => {
				if (!isRec(bulk)) return;
				const bPath = joinPath(joinPath(path, "bulkActions"), String(i));
				if (bulk.onSubmit !== undefined) {
					checkHandler(ctx, joinPath(bPath, "onSubmit"), bulk.onSubmit, "onSubmit");
				}
				if (isRec(bulk.form)) {
					const formPath = joinPath(joinPath(bPath, "form"), "root");
					if (isRec(bulk.form.root)) {
						// a nested form is never the surface's root: the placement's
						// root-block constraint must not re-apply to it (§5.7)
						checkBlock(ctx, bulk.form.root, formPath, false);
					}
				}
			});
		}
	}

	// handler names
	for (const prop of HANDLER_PROPS) {
		if (node[prop] !== undefined) {
			checkHandler(ctx, joinPath(path, prop), node[prop], prop);
		}
	}
	if (type === "collection" && isRec(node.time)) {
		const timePath = joinPath(path, "time");
		for (const prop of ["onResize", "onCreate"] as const) {
			if (node.time[prop] !== undefined) {
				checkHandler(ctx, joinPath(timePath, prop), node.time[prop], prop);
			}
		}
	}

	// ids (§4.1): unique, and required on blocks carrying actions/inputs
	const id = node.id;
	if (typeof id === "string") {
		if (ctx.ids.has(id)) {
			push(ctx, path, `duplicate id "${id}" (first seen at ${ctx.ids.get(id) ?? "root"})`);
		} else {
			ctx.ids.set(id, path);
		}
	} else if (id === undefined && carriesActionsOrInputs(type, node)) {
		push(ctx, path, `an id is required on ${type} blocks that carry actions or inputs`);
	}

	// image sources (§11.1)
	if (type === "image" && typeof node.src === "string") {
		const check = checkImageSource(node.src);
		if (!check.ok) push(ctx, joinPath(path, "src"), check.message);
	}

	// bindable props: every relative `./` binding on the node (§4.2)
	const structural = STRUCTURAL_LITERALS[type] ?? [];
	checkNodeRelativeBindings(ctx, node, path, new Set(structural));

	// onActivate carries an Action (§6.1): same rules as button actions
	if (node.onActivate !== undefined) {
		checkAction(ctx, node.onActivate, joinPath(path, "onActivate"));
	}

	// actions lists
	if (Array.isArray(node.actions)) {
		checkActionButtons(ctx, node.actions, joinPath(path, "actions"));
	}

	// form: turn is chat-only (§6.2)
	if (type === "form" && ctx.placement !== "chat" && node.turn === true) {
		push(ctx, joinPath(path, "turn"), "`turn` is valid only in the chat placement");
	}

	// children: blocks and (inside forms/sections) fields
	if (Array.isArray(node.children)) {
		const wrapperParent = type === "columns" || type === "grid";
		node.children.forEach((child, i) => {
			if (!isRec(child)) return;
			// columns/grid children are `{weight?, block}` wrappers with no
			// `type` of their own; the wrapper walk below validates `block`.
			// Other parents (stack, section, form…) type their children as
			// blocks/fields directly, so a stray record-valued `block` prop
			// must NOT skip them.
			if (wrapperParent && isRec(child.block)) return;
			if (wrapperParent && !isRec(child.block)) {
				// a wrapper child without `block` (e.g. {weight: 1}): the
			// parent schema's required-property error is the precise one
				return;
			}
			const cPath = joinPath(joinPath(path, "children"), String(i));
			const childType = child.type;
			if (typeof childType === "string" && FIELD_VALIDATORS.has(childType)) {
				checkField(ctx, child, cPath);
			} else {
				checkBlock(ctx, child, cPath, false);
			}
		});
	}

	// page columns
	for (const prop of ["sidebar", "main", "detail"]) {
		const blocks = node[prop];
		if (Array.isArray(blocks)) {
			blocks.forEach((child, i) => {
				if (isRec(child)) {
					checkBlock(ctx, child, joinPath(joinPath(path, prop), String(i)), false);
				}
			});
		}
	}

	// columns/grid wrappers
	if (type === "columns" || type === "grid") {
		if (Array.isArray(node.children)) {
			node.children.forEach((child, i) => {
				if (!isRec(child) || !isRec(child.block)) return;
				checkBlock(
					ctx,
					child.block,
					joinPath(joinPath(joinPath(path, "children"), String(i)), "block"),
					false,
				);
			});
		}
	}

	// page.switcher is a choice field
	if (type === "page" && isRec(node.switcher) && node.switcher.type === "choice") {
		checkField(ctx, node.switcher, joinPath(path, "switcher"));
	}
}

/** Whether a block of this type carries actions or inputs (§4.1 id rule). */
function carriesActionsOrInputs(type: string, node: Rec): boolean {
	switch (type) {
		case "page":
			return node.actions !== undefined;
		case "callout":
			return node.actions !== undefined;
		case "tree":
			return node.onExpand !== undefined || node.onActivate !== undefined;
		case "form":
			return true; // fields are inputs
		case "collection":
			return (
				node.onMove !== undefined ||
				node.onCheck !== undefined ||
				node.onActivate !== undefined ||
				node.bulkActions !== undefined ||
				node.reorder !== undefined ||
				node.checkable !== undefined ||
				(node.time !== undefined &&
					isRec(node.time) &&
					(node.time.onResize !== undefined || node.time.onCreate !== undefined))
			);
		default:
			return false;
	}
}

/** Count blocks (§4.5: a collection counts as one). */
function countBlocks(node: unknown): number {
	if (!isRec(node)) return 0;
	if (node.type === "collection") return 1;
	let count = 1;
	if (isRec(node.form)) count += countBlocks(node.form.root); // bulk-action form
	const arrayProps: readonly (readonly [string, boolean])[] = [
		["children", true],
		["sidebar", true],
		["main", true],
		["detail", true],
	];
	for (const [prop, recurse] of arrayProps) {
		if (!recurse) continue;
		const value = node[prop];
		if (Array.isArray(value)) {
			for (const element of value) {
				if (!isRec(element)) continue;
				if (isRec(element.block)) {
					count += countBlocks(element.block); // columns/grid wrapper
				} else {
					count += countBlocks(element);
				}
			}
		}
	}
	return count;
}

/** The ambient one-line rule for `status`/`footer` (spec §9.2). */
function checkAmbientLine(ctx: WalkCtx, root: Rec): void {
	if (ctx.placement !== "ambient" || !ctx.ambientPlace || ctx.ambientPlace === "panel") return;
	const place = ctx.ambientPlace;
	const rootType = root.type;
	if (rootType === "markdown" || rootType === "stat" || rootType === "meter" || rootType === "log") {
		return; // one line-level block
	}
	if (rootType === "stack") {
		const children = root.children;
		if (Array.isArray(children) && children.length > 1) {
			push(
				ctx,
				"root.children",
				`a ${place} ambient surface allows one line-level block`,
			);
		}
		return;
	}
	if (rootType === "columns") {
		const children = root.children;
		if (Array.isArray(children)) {
			children.forEach((child, i) => {
				if (!isRec(child) || !isRec(child.block)) return;
				const innerType = child.block.type;
				if (typeof innerType !== "string") return;
				if (!AMBIENT_LINE_BLOCKS.has(innerType)) {
					push(
						ctx,
						`root.children[${i}].block`,
						`${innerType} is not a line-level block for a ${place} ambient surface`,
					);
				}
			});
		}
		return;
	}
	// fields/callout/diff/details/details bindables are single-line roots
}

// ─── the public entry points ──────────────────────────────────────────────

/**
 * Validate a block tree against a placement (spec §14.2). Returns every
 * error with its JSON path; on success, the narrowed tree.
 */
export function validateTree(tree: unknown, opts: ValidateOptions): ValidateResult {
	// version first (§4.4): a tree from another block-set version is
	// rejected before anything else is checked.
	const serverV = opts.serverV ?? BLOCK_SET_VERSION;
	if (isRec(tree) && typeof tree.v === "number" && tree.v !== serverV) {
		return {
			ok: false,
			errors: [
				{
					path: "v",
					message: `unsupported block-set version ${tree.v} (server supports ${serverV})`,
				},
			],
		};
	}

	if (!VALID_PLACEMENTS.includes(opts.placement)) {
		return {
			ok: false,
			errors: [{ path: "root", message: `unknown placement "${String(opts.placement)}"` }],
		};
	}

	const errors: ValidationError[] = [];

	if (!isRec(tree)) {
		return {
			ok: false,
			errors: [{ path: "", message: "a tree must be {v, root}" }],
		};
	}
	if (!isRec(tree.root)) {
		return {
			ok: false,
			errors: [{ path: "root", message: "a tree must be {v, root}" }],
		};
	}

	const root = tree.root;
	const ctx: WalkCtx = {
		placement: opts.placement,
		handlers: opts.handlers,
		itemTemplate: false,
		ambientPlace: opts.ambientPlace,
		errors,
		ids: new Map(),
	};

	// limits (§4.5) — sizes are the UTF-8 length of the serialized JSON
	const limit = LIMITS[opts.placement];
	const blocks = countBlocks(root);
	if (blocks > limit.blocks) {
		push(
			ctx,
			"root",
			`surface_too_large: ${blocks} blocks exceeds the ${opts.placement} limit of ${limit.blocks} blocks`,
		);
	}
	const bytes = jsonBytes(tree);
	if (bytes > limit.treeBytes) {
		push(
			ctx,
			"root",
			`surface_too_large: tree is ${bytes} bytes, over the ${opts.placement} limit of ${limit.treeBytes} treeBytes`,
		);
	}

	checkBlock(ctx, root, "root", true);
	checkAmbientLine(ctx, root);

	return errors.length === 0 ? { ok: true, tree: tree as Tree } : { ok: false, errors };
}

/**
 * Validate a surface's data object: a JSON object within the placement's
 * data-size limit (spec §4.5).
 */
export function validateData(data: unknown, placement: Placement): ValidateDataResult {
	if (!isRec(data)) {
		return {
			ok: false,
			errors: [{ path: "", message: "surface data must be a JSON object" }],
		};
	}
	const bytes = jsonBytes(data);
	const limit = LIMITS[placement];
	if (bytes > limit.dataBytes) {
		return {
			ok: false,
			errors: [
				{
					path: "",
					message: `surface_too_large: data is ${bytes} bytes, over the ${placement} limit of ${limit.dataBytes} dataBytes`,
				},
			],
		};
	}
	return { ok: true };
}
