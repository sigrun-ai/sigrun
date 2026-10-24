import { randomBytes } from "node:crypto";
import type { LoginFlow } from "../../extension.js";

const FLOW_TTL_MS = 600_000;

/** The server-side login state handed to the resolver after `complete`. */
export interface StoredFlow extends LoginFlow {
	readonly provider: string;
	readonly returnTo: string;
	readonly link?: string;
	readonly expiresAt: number;
}

interface FlowEntry {
	readonly provider: string;
	readonly state: string;
	callbackUrl: string;
	data: Record<string, string>;
	readonly returnTo: string;
	readonly link?: string;
	readonly browserKey: string;
	readonly expiresAt: number;
}

/** One short-lived random browser/state credential. */
function key(): string {
	return randomBytes(32).toString("base64url");
}

/**
 * In-memory, per-server login flows. `take` is atomic and single-use: a
 * replay, a different browser key, or an expired entry returns undefined.
 */
export class LoginFlows {
	readonly #now: () => number;
	readonly #flows = new Map<string, FlowEntry>();
	readonly #consumed = new Map<string, { browserKey: string; expiresAt: number }>();

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	start(
		provider: string,
		opts: { returnTo: string; link?: string },
	): LoginFlow & { browserKey: string } {
		this.#prune();
		const state = key();
		const browserKey = key();
		const flow: FlowEntry = {
			provider,
			state,
			callbackUrl: "",
			data: {},
			returnTo: opts.returnTo,
			...(opts.link === undefined ? {} : { link: opts.link }),
			browserKey,
			expiresAt: this.#now() + FLOW_TTL_MS,
		};
		this.#flows.set(state, flow);
		return flow;
	}

	/** Save provider scratch data and the callback URL after `begin` succeeds. */
	save(state: string, flow: LoginFlow): void {
		const stored = this.#flows.get(state);
		if (stored === undefined) return;
		stored.callbackUrl = flow.callbackUrl;
		stored.data = flow.data;
	}

	take(state: string, browserKey: string): StoredFlow | undefined {
		this.#prune();
		const flow = this.#flows.get(state);
		if (flow === undefined || flow.browserKey !== browserKey) return undefined;
		this.#flows.delete(state);
		this.#consumed.set(state, {
			browserKey,
			expiresAt: flow.expiresAt,
		});
		return flow;
	}

	/** Explain a failed take without exposing flow data (replay vs expired/unknown). */
	failure(state: string, browserKey: string): "invalid_state" | "login_expired" {
		this.#prune();
		if (this.#flows.has(state)) return "invalid_state";
		return this.#consumed.get(state)?.browserKey === browserKey
			? "invalid_state"
			: "login_expired";
	}

	#prune(): void {
		const now = this.#now();
		for (const [state, flow] of this.#flows) {
			if (flow.expiresAt <= now) this.#flows.delete(state);
		}
		for (const [state, consumed] of this.#consumed) {
			if (consumed.expiresAt <= now) this.#consumed.delete(state);
		}
	}
}
