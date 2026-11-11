/** The live registry reads behind System → Models. Never snapshot at boot. */

import type { ChoiceOption, JsonObject, JsonValue, Tree } from "@sigrun/shared/blocks";
import type { OpenedHarness } from "../harness/boot.js";
import type { Locality } from "../harness/locality.js";
import { MODEL_KINDS, type ModelKindId, type ModelRoster } from "../settings/model-kinds.js";

function option(id: string, providerTitle: string, local: boolean): ChoiceOption {
	return { id, label: `${id} · ${providerTitle}${local ? " · local" : ""}` };
}

/** Read all three model registries per call. Option ids stay provider/model. */
export function buildModelRoster(
	opened: OpenedHarness,
	locality: Locality,
	titleOf: (slug: string) => string,
): ModelRoster {
	const chat = opened.models.getModels().map((model) => {
		const id = `${model.provider}/${model.id}`;
		const owner = opened.providerOwnership.get(model.provider) ?? "core";
		return option(id, titleOf(owner), locality.isLocalModel("chat", id));
	});
	const decision = opened.decisions.providers().flatMap((provider) => provider.models.map((model) => {
		const id = `${provider.id}/${model}`;
		return option(id, titleOf(provider.extension), locality.isLocalModel("decision", id));
	}));
	const embedding = opened.embeddings.providers().flatMap((provider) => provider.models.map((model) => {
		const id = `${provider.id}/${model}`;
		return option(id, titleOf(provider.extension), locality.isLocalModel("embedding", id));
	}));
	return { chat, decision, embedding };
}

/** Append a stored absent value, with the plain id as its label fallback. */
export function withUnserved(
	options: ChoiceOption[],
	value: string | undefined,
): ChoiceOption[] {
	if (value === undefined || value === "" || options.some((row) => row.id === value)) return options;
	return [...options, { id: value, label: `${value} (not currently served)` }];
}

function record(value: JsonValue | undefined): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function liveRows(data: JsonObject, kind: ModelKindId): number {
	// Live rows, not the served+stored projection. Preferences mode
	// consumers retain the payload's plain {chat,decision,embedding} rosters.
	return asLiveModelCounts(data.modelLiveCounts)[kind] ?? 0;
}

/** Live per-kind registry rows are read fresh by the core adapter. */
export function liveModelCounts(opened: OpenedHarness): Readonly<Record<ModelKindId, number>> {
	return {
		chat: opened.models.getModels().length,
		decision: opened.decisions.providers().reduce((n, p) => n + p.models.length, 0),
		embedding: opened.embeddings.providers().reduce((n, p) => n + p.models.length, 0),
	};
}

/** Typed read of the same transport record, avoiding a payload-wide cast. */
function asLiveModelCounts(value: JsonValue | undefined): Readonly<Record<ModelKindId, number>> {
	const obj = record(value);
	return {
		chat: typeof obj?.chat === "number" ? obj.chat : 0,
		decision: typeof obj?.decision === "number" ? obj.decision : 0,
		embedding: typeof obj?.embedding === "number" ? obj.embedding : 0,
	};
}

/** Omit an empty kind, but never an unserved STORED value. The utility field
 * shares the chat roster but gets its own storage gate: namingModel must not
 * keep defaultModel present (or vice versa) as a consequence of a refresh. */
export function withoutEmptyModelKind(tree: Tree, data: JsonObject): Tree {
	if (tree.root.type !== "form") return tree;
	const settings = record(data.settings);
	return {
		...tree,
		root: {
			...tree.root,
			children: tree.root.children.map((child) => child.type !== "section" ? child : {
				...child,
				children: child.children.filter((field) => {
					if (!("name" in field) || field.type !== "choice") return true;
					const options = field.options;
					// SAFETY: TypeScript's Array.isArray accepts the readonly-side
					// list but retains it in its negative narrowing. This runtime
					// record/non-list check selects only the { $: string } arm of
					// Bindable<ChoiceOption[]>; the transport walk owns the pointer.
					const opts = typeof options === "object" && options !== null && !Array.isArray(options)
						? options as { readonly $?: string }
						: undefined;
					const binding = opts?.$;
					const fieldKind = MODEL_KINDS.find((entry) => `/modelRoster/${entry.kind}` === binding);
					if (fieldKind === undefined) return true;
					// Each field owns this storage gate, even while defaultModel and
					// namingModel share the chat roster. The current live rows must
					// be consulted independently of any withUnserved append.
					return (
						(liveRows(data, fieldKind.kind) > 0) ||
						(typeof settings?.[field.name] === "string" && settings[field.name] !== "")
					);
				}),
			}),
		},
	};
}

/** Model rosters plus each stored absent id. There is no default-first row:
 * unlike My Models, this System page edits the system value directly. */
export function systemModelRosterData(
	roster: ModelRoster,
	stored: { defaultModel?: string; namingModel?: string; decisionModel?: string; embeddingModel?: string },
): ModelRoster {
	return {
		chat: withUnserved(withUnserved(roster.chat, stored.defaultModel), stored.namingModel),
		decision: withUnserved(roster.decision, stored.decisionModel),
		embedding: withUnserved(roster.embedding, stored.embeddingModel),
	};
}
