/**
 * Interactions (the seam's channel half, docs/approval-ux-seams.md),
 * UI-blocks U6 Task 3: the pending-decision card stack, rendered from
 * block trees.
 *
 * A card renders its record's block tree (placement `interaction` — a
 * root `form` whose submit is the answer, spec §9.1) through the shared
 * renderer against a {@link createInteractionTransport}: the record IS
 * the surface (the tree is the load, the form's submit POSTs `{values}`
 * to the one generic answer route — ruling 20). The stepper (several
 * sections each holding a choice) arrives through the form block's
 * interaction flag, threaded through the renderer.
 *
 * Settled records render READ-ONLY with their stored answer seeding the
 * form (access `read`); a submit that lands on an already-settled record
 * (404 not_pending — expiry mid-stepper, Review Focus 2) refetches the
 * record, shows its settled status, and keeps the typed values visible
 * but read-only (the form's state survives — the tree never changed).
 *
 * `details` renders collapsed, never interpreted.
 */

import { useMemo, useState, type ReactNode } from "react";
import type {
	Action,
	Block,
	JsonObject,
	JsonValue,
	Tree,
} from "@sigrun/shared/blocks";
import type { InteractionWire, SigrunClient } from "../api";
import { BlockView } from "../blocks/BlockView";
import {
	SurfaceActionsContext,
	SurfaceDataContext,
} from "../blocks/context";
import { ContainerWidth } from "../blocks/width";
import { createInteractionTransport } from "./interactionTransport";

/** The record-as-surface data document: the form binds `/values`, so
 *  the document is `{values}` — a settled record's stored answer seeds
 *  the read-only render (secret fields carry the status strings the
 *  server masked; the secret field renders write-only regardless). */
function recordData(record: InteractionWire): JsonObject {
	if (record.answer === undefined) return {};
	return { values: { ...record.answer.values } } as JsonObject;
}

/** One interaction card (a pending prompt or a settled record). */
export function InteractionCard(props: {
	conversationId: number;
	interaction: InteractionWire;
	client: SigrunClient;
	onAnswered?: (callId: string) => void;
	onError?: (message: string) => void;
}): ReactNode {
	const { conversationId, interaction, client, onAnswered, onError } = props;
	// The refetched record after a settle lands mid-edit (Review Focus
	// 2): the card swaps to the settled envelope (read-only) while the
	// typed values stay on screen (the form keeps its state).
	const [settled, setSettled] = useState<InteractionWire | undefined>(
		undefined,
	);
	const record = settled ?? interaction;
	const pending = record.status === "pending" && settled === undefined;

	const transport = useMemo(
		() =>
			record.body === undefined
				? undefined
				: createInteractionTransport({
						conversationId,
						callId: record.callId,
						tree: record.body,
						data: recordData(record),
						access: pending ? "write" : "read",
						submitAction: submitActionOf(record.body),
						answer: (body) =>
							client
								.answerInteraction(conversationId, record.callId, body)
								.then(() => undefined),
						onAnswered: () => onAnswered?.(record.callId),
						onSettledElsewhere: (message) => {
							// The settle raced the user's submit (expiry, another
							// channel, the extension): refetch the record and render
							// it settled; a refetch failure reports the error loud.
							client
								.getInteraction(conversationId, record.callId)
								.then((fresh: InteractionWire) => {
									// Only a genuinely settled record swaps in: a
									// still-pending refetch (a 400, a network blip)
									// must NOT wedge the card read-only — report
									// the failure and stay writable (Review fix).
									if (fresh.status === "pending") {
										onError?.(message);
										return;
									}
									setSettled(fresh);
								})
								.catch(() => onError?.(message));
						},
					}),
		// The transport is the card's identity; a new record re-creates it.
		[record, conversationId, client, pending, onAnswered, onError],
	);

	return (
		<div className="interaction-card" data-kind={record.kind}>
			<div className="interaction-card-title">
				<span className="interaction-kind">{record.kind}</span>
				{record.expiresAt !== undefined && pending && (
					<span className="interaction-expiry">expires</span>
				)}
				{!pending && (
					<span className="interaction-status" data-status={record.status}>
						{record.status}
					</span>
				)}
			</div>
			{transport !== undefined && record.body !== undefined && (
				<InteractionSurface
					record={record}
					transport={transport}
					access={pending ? "write" : "read"}
				/>
			)}
			{record.details !== undefined && (
				<details className="interaction-details">
					<summary>details</summary>
					<pre>{JSON.stringify(record.details, null, 2)}</pre>
				</details>
			)}
		</div>
	);
}

/** The card's tree rendered against the record transport. Unlike
 *  `SurfaceView` (whose loading/not-found states never occur — the
 *  record is already in hand), this renders the ready state directly. */
function InteractionSurface(props: {
	record: InteractionWire;
	transport: ReturnType<typeof createInteractionTransport>;
	access: "read" | "write";
}): ReactNode {
	const tree: Tree = props.record.body as Tree;
	const actions = useMemo(
		() => ({
			dispatch: (action: Action, payload: JsonValue): void => {
				const name = "name" in action ? action.name : action.type;
				void props.transport.act({
					action: name,
					type: action.type,
					payload,
					actionId: `answer-${Date.now()}`,
				});
			},
			access: props.access,
			viewState: {} as JsonObject,
			serverErrors: {} as Readonly<Record<string, string>>,
			setView: (): void => {},
		}),
		[props.transport, props.access],
	);
	return (
		<SurfaceDataContext.Provider
			value={{ data: recordData(props.record), locale: navigator.language }}
		>
			<SurfaceActionsContext.Provider value={actions}>
				<ContainerWidth>
					<BlockView block={tree.root} interaction />
				</ContainerWidth>
			</SurfaceActionsContext.Provider>
		</SurfaceDataContext.Provider>
	);
}

/** The root form's submit action name (`onSubmit ?? "submit"` — the
 *  ONLY action the transport answers on; anything else is ignored). */
function submitActionOf(tree: Tree): string {
	const root: Block = tree.root;
	return root.type === "form" ? (root.onSubmit ?? "submit") : "submit";
}

/** The pending card stack. */
export function InteractionCards(props: {
	conversationId: number | null;
	interactions: readonly InteractionWire[];
	client: SigrunClient;
	onAnswered?: (callId: string) => void;
	onError?: (message: string) => void;
}): ReactNode {
	const { conversationId, interactions, client, onAnswered, onError } = props;
	if (conversationId === null || interactions.length === 0) return null;
	return (
		<div className="interaction-cards">
			{interactions.map((interaction) => (
				<InteractionCard
					key={interaction.callId}
					conversationId={conversationId}
					interaction={interaction}
					client={client}
					onAnswered={onAnswered}
					onError={onError}
				/>
			))}
		</div>
	);
}
