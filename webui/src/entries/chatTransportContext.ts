/**
 * The chat-block transport context (UI-blocks U5 Task 4): the app shell
 * provides ONE attach seam — `(conversationId, entryId) → SurfaceTransport`
 * — that BlocksEntry instances subscribe through. The default throws
 * (a transcript block outside a provided shell is a wiring bug, never a
 * silent no-op transport).
 *
 * The shell's implementation attaches into its `ChatSurfaceHub` (the
 * conversation-scoped `surface.changed` frames dispatch into it), so an
 * inline surface updates when another viewer edits the block.
 */

import { createContext, useContext } from "react";
import type { SurfaceTransport } from "@sigrun/shared/blocks";
import type { ChatTransportOptions } from "../blocks/chatTransport";

/** The attach seam the shell provides (hub-backed in the real app). */
export type AttachChatTransport = (
	options: ChatTransportOptions,
) => SurfaceTransport;

const missing: AttachChatTransport = () => {
	throw new Error("chat transport context missing (the shell provides it)");
};

export const ChatTransportContext = createContext<AttachChatTransport>(missing);

/** The BlocksEntry seam: the shell's attach (hub-backed). */
export function useChatTransport(): AttachChatTransport {
	return useContext(ChatTransportContext);
}
