/**
 * Display-only sitting boundaries: a typed pi-durable entry whose data
 * names an earlier entry and the label of the sitting beginning there.
 * It carries no `model` messages and therefore changes no model context.
 */

import { defineEntry } from "@earendil-works/pi-durable";
import type { Entry } from "@earendil-works/pi-durable";
import { CONTEXT_MARK_KIND } from "@sigrun/shared/turns";
import type { ContextMarkData } from "@sigrun/shared/turns";

/** One display-only sitting boundary in the transcript. */
export const ContextMarkEntry: Entry<ContextMarkData> =
	defineEntry<ContextMarkData>(CONTEXT_MARK_KIND);
