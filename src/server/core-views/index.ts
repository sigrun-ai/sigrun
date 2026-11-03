/**
 * Core-owned views (tabs+skills Task 4): the reserved `core` slug's
 * built-in view surfaces (the Jobs and Skills views, attached by Tasks
 * 5 and 12 via `SurfaceService.attachCoreViews`).
 *
 * Core views are NOT extensions: they have no outcome row, so the
 * health dot is unaffected, and the `/v1/extensions` + `/v1/meta`
 * routes list them under `coreViews`, never `extensions[]`. Rendering,
 * data, actions, and instance-key/rev machinery run through the SAME
 * `SurfaceService` code path as extension surfaces — this module only
 * owns the wire projection.
 */

import type { CoreViewInfo } from "@sigrun/shared/views";
import type { SurfaceDef } from "../../extension.js";

/**
 * The wire rows for a list of core-view defs: one {@link CoreViewInfo}
 * per def, in attachment order (the channels list core views FIRST,
 * ahead of extension views). `refreshMs` is sparse — absent when the
 * def declares no cadence.
 */
export function coreViewInfos(
	defs: readonly SurfaceDef<"view">[],
): CoreViewInfo[] {
	return defs.map((def) => ({
		id: def.id,
		title: def.title,
		icon: def.icon,
		...(def.refreshMs === undefined ? {} : { refreshMs: def.refreshMs }),
	}));
}
