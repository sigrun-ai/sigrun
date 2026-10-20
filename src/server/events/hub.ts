/**
 * The host event hub (core hardening W3 Task 4, spec §7.4): the single
 * in-process fan-out point for `HostEventWire` events. Boot creates ONE
 * hub, subscribes it to the event bus's `onHostEvent` (commit-derived
 * conversation/run/interaction/ambient events) and the provider refresh
 * paths' `onReadinessChange` callback (`providers.changed`), and exposes
 * it on `OpenedHarness.events`.
 *
 * The hub itself is deliberately tiny — a publish/subscribe registry.
 * The listener contract mirrors the bus's: `publish` invokes subscribers
 * synchronously in install order; a throwing subscriber is logged and
 * the rest still receive the event (one bad consumer must never wedge
 * the commit-observation path upstream of it). Delivery concern for the
 * SSE route's filtering (a per-event async SessionMeta re-snapshot) lives
 * in the ROUTE's own side lane, not here — the hub never blocks.
 */

import type { HostEventWire } from "./types.js";

/** The hub's subscriber contract: synchronous, no blocking work. */
export type EventHubListener = (event: HostEventWire) => void;

export class EventHub {
	#listeners: EventHubListener[] = [];

	/** Fan one event out to every subscriber (install order). Never throws. */
	publish(event: HostEventWire): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (error) {
				console.error("events hub: subscriber failed:", error);
			}
		}
	}

	/** Subscribe; returns the unsubscribe (identity-guarded, first match). */
	subscribe(listener: EventHubListener): () => void {
		this.#listeners.push(listener);
		return () => {
			const index = this.#listeners.indexOf(listener);
			if (index >= 0) this.#listeners.splice(index, 1);
		};
	}
}
