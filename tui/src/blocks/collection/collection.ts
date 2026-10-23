/**
 * The `collection` block (UI-blocks spec §5.5): the display dispatch.
 * `list`, `table` and `grid` are this task's displays; `lanes` and
 * `calendar` are Task 4's and fall through to the renderer's §4.4
 * unsupported notice (render.ts) — this module answers `undefined` for
 * them so the front door owns the notice wording.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { CollectionBlock } from "@sigrun/shared/blocks";
import type { BlockCtx } from "../context.js";
import { GridComponent } from "./grid.js";
import { ListComponent } from "./list.js";
import { TableComponent } from "./table.js";

/** The display dispatch; `lanes`/`calendar` answer `undefined`. */
export function renderCollection(block: CollectionBlock, ctx: BlockCtx): Component | undefined {
	switch (block.display) {
		case "list":
			return new ListComponent(block, ctx);
		case "table":
			return new TableComponent(block, ctx);
		case "grid":
			return new GridComponent(block, ctx);
		default:
			// lanes + calendar: Task 4. The front door shows §4.4's notice.
			return undefined;
	}
}
