/**
 * The `collection` block (UI-blocks spec §5.5): the display dispatch.
 * Task 3 owns `list`/`table`/`grid`; Task 4 owns `lanes`/`calendar`.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { CollectionBlock } from "@sigrun/shared/blocks";
import type { BlockCtx } from "../context.js";
import { CalendarComponent } from "./calendar.js";
import { GridComponent } from "./grid.js";
import { LanesComponent } from "./lanes.js";
import { ListComponent } from "./list.js";
import { TableComponent } from "./table.js";

/** The display dispatch. */
export function renderCollection(block: CollectionBlock, ctx: BlockCtx): Component | undefined {
	switch (block.display) {
		case "list":
			return new ListComponent(block, ctx);
		case "table":
			return new TableComponent(block, ctx);
		case "grid":
			return new GridComponent(block, ctx);
		case "lanes":
			return new LanesComponent(block, ctx);
		case "calendar":
			return new CalendarComponent(block, ctx);
		default:
			return undefined;
	}
}
