/**
 * The surface transport (UI-blocks U0): the ONE interface both clients'
 * block renderers talk to a surface through. Implemented by U3
 * (extension surfaces, over HTTP/SSE) and U5 (chat, in-process); U1
 * (webui) and U2 (tui) consume it — so the clients' surface code never
 * knows which kind of surface it is holding.
 *
 * Types only. The wire shapes come from the sibling modules; nothing
 * here is runtime.
 */

import type { JsonObject, JsonValue } from "../json.js";
import type { Action, DataOp, Tree } from "./types.js";

/** The principal's access to a surface (spec §6.5). */
export type SurfaceAccess = "none" | "read" | "write";

/** The initial-load result: everything a first render needs. */
export interface SurfaceLoad {
	tree: Tree;
	data: JsonObject;
	rev: number;
	treeRev: number;
	access: SurfaceAccess;
}

/** An incremental fetch: ops since `since` when the surface shares data
 *  (§7.3), else the full `data` object; `rev`/`treeRev` always current. */
export interface SurfaceFetch {
	rev: number;
	treeRev: number;
	data?: JsonObject;
	ops?: DataOp[];
}

/** What a handler's accepted action returns (§6.3). */
export type SurfaceActOk = {
	ok: true;
	rev: number;
	ops?: DataOp[];
	navigate?: Action;
	toast?: string;
};

/** What a rejected action returns. */
export type SurfaceActErr = {
	ok: false;
	error: { message: string; field?: string };
};

export type SurfaceActResult = SurfaceActOk | SurfaceActErr;

/** An upload through the surface's upload route (§7.2). */
export interface SurfaceUploadBody {
	field: string;
	name: string;
	bytes: Uint8Array;
	actionId: string;
}

/** A change notification (fed by `surface.changed`, §7.3). */
export interface SurfaceChangedEvent {
	rev: number;
	treeRev: number;
}

/** The channel-facing surface handle (load, fetch, act, upload, image,
 *  subscribe). `image` fetches through the server's proxy for the TUI
 *  (§11.3); `onChanged` listeners fire on every surface change. */
export interface SurfaceTransport {
	load(): Promise<SurfaceLoad>;
	fetchData(since?: number): Promise<SurfaceFetch>;
	act(body: {
		action: string;
		payload: JsonValue;
		actionId: string;
	}): Promise<SurfaceActResult>;
	upload(body: SurfaceUploadBody): Promise<SurfaceActResult>;
	/** TUI image fetch (U7 routes); `asPng` selects the decodable form. */
	image(src: string, opts: { asPng: boolean }): Promise<Uint8Array>;
	onChanged(listener: (e: SurfaceChangedEvent) => void): () => void;
}
