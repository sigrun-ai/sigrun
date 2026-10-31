/**
 * `useDraft` (Task 23b): the per-session persistent composer draft. Task 24
 * added ATTACHMENTS: the uploaded workspace-relative paths ride the same
 * session-meta draft (`draft.attachments`) so the tray survives a reload.
 *
 * - RESTORE: on mount and on conversation switch, GET
 *   `/v1/conversations/:id/meta` and seed the composer text from
 *   `draft.text` and the attachment tray from `draft.attachments`
 *   (server-side session meta — the draft survives a reload).
 * - SAVE (text): `setText` schedules a debounced PATCH `{ draft: { text } }`
 *   (a draft sub-merge — attachments survive); rapid edits coalesce into one
 *   PATCH with the latest text.
 * - SAVE (attachments): `addAttachment`/`removeAttachment` PATCH
 *   `{ draft: { attachments } }` IMMEDIATELY (no debounce — an uploaded file
 *   is already on the server; the tray must never lag a reload). Adding a
 *   path already in the tray is a no-op (dedup).
 * - A pending text save FLUSHES on switch/unmount (the draft is never
 *   stranded in the debounce window); the flush re-reads the latest text via
 *   a ref, so a text change that races the switch still lands.
 * - The PRE-CONVERSATION DRAFT CARRY (Task 6, the empty state): a draft
 *   typed with no conversation belongs to no conversation, so the FIRST
 *   null→conversation switch (the boot default selecting a row, a sidebar
 *   navigation, the first send's own create→navigate) carries the draft
 *   INTO the conversation selected and persists it there at once — never
 *   wipes it. An empty pre-conversation draft is no carry (the switch
 *   restores the served draft as before).
 * - The restore never echoes back as a PATCH (the dirty flag tracks
 *   user edits only).
 * - `clear(persist: true)` (post-submit) clears BOTH text and attachments
 *   and persists `{ draft: { text: "", attachments: [] } }` — the submitted
 *   message must not resurrect from a late flush OR a reload.
 *
 * Fail-loud: a failed restore leaves the composer empty and the stream/UI
 * unaffected; a failed save rejects the debounce promise, which is caught
 * and surfaced via the optional `onError` hook rather than crashing the
 * app (the draft text is still in the textarea).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SigrunClient } from "../api";

/** The debounce window for draft saves (ms). */
export const DRAFT_SAVE_DEBOUNCE_MS = 500;

export interface UseDraftResult {
	readonly text: string;
	/** User edit: updates the composer text and schedules the save. */
	readonly setText: (text: string) => void;
	/**
	 * Drop the text AND the attachments. The pending debounced save is
	 * cancelled so the just-sent text cannot resurrect from a late flush.
	 * `persist: true` (post-submit) also writes the empty draft (text AND
	 * attachments) to the server so a reload doesn't restore the submitted
	 * message; the default (switch/reset) doesn't persist.
	 */
	readonly clear: (persist?: boolean) => void;
	/** The attachment tray: workspace-relative upload paths. */
	readonly attachments: readonly string[];
	/**
	 * Add an uploaded path to the tray and persist IMMEDIATELY (no debounce).
	 * Adding a path already in the tray is a no-op.
	 */
	readonly addAttachment: (path: string) => void;
	/** Remove a path from the tray and persist IMMEDIATELY. */
	readonly removeAttachment: (path: string) => void;
}

export function useDraft(
	client: SigrunClient,
	conversationId: number | null,
	options?: {
		readonly debounceMs?: number;
		readonly onError?: (message: string) => void;
	},
): UseDraftResult {
	const debounceMs = options?.debounceMs ?? DRAFT_SAVE_DEBOUNCE_MS;
	const [text, setTextState] = useState("");
	const [attachments, setAttachmentsState] = useState<readonly string[]>([]);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const textRef = useRef(text);
	textRef.current = text;
	// The attachments mirror-ref: add/remove compute the next list from the
	// ref (never inside a state updater — updaters may re-run) and persist
	// that exact list.
	const attachmentsRef = useRef<readonly string[]>(attachments);
	attachmentsRef.current = attachments;
	const editGenerationRef = useRef(0);
	const dirtyRef = useRef(false);
	// The latest client/id, read by the debounce timer callback.
	const saveRef = useRef({ client, conversationId });
	saveRef.current = { client, conversationId };

	const onErrorRef = useRef(options?.onError);
	onErrorRef.current = options?.onError;

	const save = useCallback((id: number, value: string) => {
		saveRef.current.client
			.patchConversationMeta(id, { draft: { text: value } })
			.catch((cause: unknown) => {
				onErrorRef.current?.(
					cause instanceof Error ? cause.message : String(cause),
				);
			});
	}, []);

	const saveAttachments = useCallback(
		(id: number, paths: readonly string[]) => {
			saveRef.current.client
				.patchConversationMeta(id, {
					draft: { attachments: [...paths] },
				})
				.catch((cause: unknown) => {
					onErrorRef.current?.(
						cause instanceof Error ? cause.message : String(cause),
					);
				});
		},
		[],
	);

	// The UNANCHORED-draft tracker (Task 6, the empty state): text typed
	// with NO conversation belongs to no conversation — it follows the user
	// through conversation switches (a late boot default, a sidebar
	// navigation, the New button) until something anchors it: an edit made
	// while a conversation is active, a served-draft restore landing, or the
	// send's clear. Without this, any typed empty-state text is silently
	// destroyed by whichever conversation switch lands first.
	const unanchoredRef = useRef(false);

	useEffect(() => {
		let cancelled = false;
		// THE SWITCH CLEANUP — EVERY run registers it (the carry branch and
		// the null early-return included): on switch/unmount, cancel the
		// in-flight restore AND flush a pending debounced save. The text the
		// user typed belongs to THIS conversation, and the debounce window
		// must not strand it — nor leak the timer into the NEXT conversation
		// (a leaked timer fires with `saveRef.current` already pointing at
		// the NEW id, flushing the OLD text — or the post-reset empty text —
		// over the new conversation's stored draft). Use THIS closure's
		// conversationId/client (the OLD values at cleanup), NOT
		// saveRef.current (reassigned in the render body to the NEW
		// conversation before this cleanup runs).
		const cleanup = (): void => {
			cancelled = true;
			if (debounceRef.current !== null) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
				if (dirtyRef.current && conversationId !== null) {
					client
						.patchConversationMeta(conversationId, {
							draft: { text: textRef.current },
						})
						.catch((cause: unknown) => {
							onErrorRef.current?.(
								cause instanceof Error ? cause.message : String(cause),
							);
						});
				}
			}
		};
		// THE UNANCHORED-DRAFT CARRY: a non-empty draft typed with no
		// conversation carries INTO the conversation this switch selects (and
		// persists there at once — like an attachment add, since the carry
		// switch has no prior conversation to flush to), skipping the
		// served-draft restore: the carried draft is newer than any served
		// draft for a conversation the user just entered by construction. It
		// stays unanchored — the user never deliberately attached it — so a
		// further switch carries it along too. Returns the SAME cleanup: a
		// draft typed in the carried-into conversation schedules a debounce
		// AFTER the carry, and the next switch must flush/clear it (a bare
		// `return` here leaked that timer into the following conversation).
		if (
			conversationId !== null &&
			unanchoredRef.current &&
			(textRef.current !== "" || attachmentsRef.current.length > 0)
		) {
			if (debounceRef.current !== null) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
			}
			dirtyRef.current = false;
			save(conversationId, textRef.current);
			saveAttachments(conversationId, attachmentsRef.current);
			return cleanup;
		}
		// Restore the served draft on mount/switch; reset the dirty state so
		// a previous conversation's pending save cannot bleed into this one.
		// The reset+restore path ANCHORS the draft (whatever lands belongs to
		// this conversation).
		unanchoredRef.current = false;
		setTextState("");
		textRef.current = "";
		setAttachmentsState([]);
		attachmentsRef.current = [];
		dirtyRef.current = false;
		if (conversationId === null) return cleanup;
		const restoreGeneration = editGenerationRef.current;
		client
			.getConversationMeta(conversationId)
			.then((meta) => {
				if (cancelled) return;
				// A slow restore is older than any local edit made while it was
				// in flight. Never replace that newer work with the served draft.
				if (restoreGeneration === editGenerationRef.current) {
					setTextState(meta.draft.text);
					textRef.current = meta.draft.text;
					setAttachmentsState(meta.draft.attachments);
					attachmentsRef.current = meta.draft.attachments;
				}
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				options?.onError?.(
					cause instanceof Error ? cause.message : String(cause),
				);
			});
		return cleanup;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [client, conversationId]);


	const setText = useCallback(
		(next: string) => {
			editGenerationRef.current += 1;
			setTextState(next);
			textRef.current = next;
			dirtyRef.current = true;
			// An edit with a live conversation ANCHORS the draft (it belongs to
			// this conversation); an edit with none leaves/sets it unanchored
			// (the empty-state text follows the user until a send consumes it).
			unanchoredRef.current = conversationId === null;
			if (conversationId === null) return;
			if (debounceRef.current !== null) clearTimeout(debounceRef.current);
			debounceRef.current = setTimeout(() => {
				debounceRef.current = null;
				dirtyRef.current = false;
				save(saveRef.current.conversationId as number, textRef.current);
			}, debounceMs);
		},
		[conversationId, debounceMs, save],
	);

	const clear = useCallback(
		(persist = false) => {
			setTextState("");
			textRef.current = "";
			setAttachmentsState([]);
			attachmentsRef.current = [];
			editGenerationRef.current += 1;
			dirtyRef.current = false;
			// The send consumed the draft — nothing left to carry.
			unanchoredRef.current = false;
			if (debounceRef.current !== null) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
			}
			// A post-submit clear must persist (the server meta keeps the
			// submitted text AND the tray otherwise, and a reload resurrects
			// them into the composer). Default false for the switch/reset paths
			// (the restore effect owns those).
			if (persist) {
				const id = saveRef.current.conversationId;
				if (id !== null) {
					saveRef.current.client
						.patchConversationMeta(id, {
							draft: { text: "", attachments: [] },
						})
						.catch((cause: unknown) => {
							onErrorRef.current?.(
								cause instanceof Error ? cause.message : String(cause),
							);
						});
				}
			}
		},
		[],
	);

	const addAttachment = useCallback(
		(path: string) => {
			if (attachmentsRef.current.includes(path)) return;
			const next = [...attachmentsRef.current, path];
			editGenerationRef.current += 1;
			attachmentsRef.current = next;
			setAttachmentsState(next);
			const id = saveRef.current.conversationId;
			if (id !== null) saveAttachments(id, next);
		},
		[saveAttachments],
	);

	const removeAttachment = useCallback(
		(path: string) => {
			if (!attachmentsRef.current.includes(path)) return;
			const next = attachmentsRef.current.filter((p) => p !== path);
			editGenerationRef.current += 1;
			attachmentsRef.current = next;
			setAttachmentsState(next);
			const id = saveRef.current.conversationId;
			if (id !== null) saveAttachments(id, next);
		},
		[saveAttachments],
	);

	return { text, setText, clear, attachments, addAttachment, removeAttachment };
}
