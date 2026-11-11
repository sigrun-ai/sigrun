/** Core's model kinds and the each-kind default settings key. Keep the
 * ids and this row order when adding a kind. The matching registry plus
 * its settings key complete the addition. */

import type { ChoiceOption } from "@sigrun/shared/blocks";

export type ModelKindId = "chat" | "decision" | "embedding";

export const MODEL_KINDS: readonly {
	readonly kind: ModelKindId;
	readonly settingKey: "defaultModel" | "decisionModel" | "embeddingModel";
	readonly title: "Chat model" | "Decision model" | "Embedding model";
}[] = [
	{ kind: "chat", settingKey: "defaultModel", title: "Chat model" },
	{ kind: "decision", settingKey: "decisionModel", title: "Decision model" },
	{ kind: "embedding", settingKey: "embeddingModel", title: "Embedding model" },
];

export type ModelRoster = Record<ModelKindId, ChoiceOption[]>;
