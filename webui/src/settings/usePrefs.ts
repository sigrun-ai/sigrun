/**
 * usePrefs: the client-only interface preferences (localStorage-backed —
 * the 2026-10-15 quick-wins ruling: UI display prefs never touch the
 * server settings file, whose PATCH validates keys strictly).
 *
 * One JSON document under one storage key, merged over defaults per field
 * so a future pref addition never orphans the stored document. Garbage
 * (unparseable JSON, wrong types) falls back to the defaults field-wise.
 *
 * Injectable storage like useTheme: the app uses localStorage, tests pass
 * a fake (the webui suite runs under react-test-renderer with no DOM);
 * no localStorage falls back to a session memory store.
 */

import { useState } from "react";

export const PREFS_STORAGE_KEY = "sigrun.prefs";

/** The client-only interface preferences and their shipped defaults. */
export interface Prefs {
	/**
	 * Enter submits the prompt (Ctrl+Enter always does). Default off —
	 * the composer's default submit chord is Ctrl+Enter.
	 */
	readonly enterToSend: boolean;
	/**
	 * Thinking blocks render in the transcript (collapsible). Default on —
	 * false hides them completely.
	 */
	readonly showThinking: boolean;
}

export type PrefKey = keyof Prefs;

export const DEFAULT_PREFS: Prefs = {
	enterToSend: false,
	showThinking: true,
};

/** The storage surface the hook needs (localStorage, or a test fake). */
export interface PrefsStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/* The no-localStorage fallback (private browsing modes, odd embeds): state
   works for the session, nothing persists across reloads. */
const memoryStorage: PrefsStorage = (() => {
	const map = new Map<string, string>();
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => {
			map.set(key, value);
		},
	};
})();

function defaultStorage(): PrefsStorage {
	const candidate = (globalThis as { localStorage?: PrefsStorage })
		.localStorage;
	return candidate ?? memoryStorage;
}

/** Field-wise parse of the STORED document: only the valid fields present. */
function parseStored(stored: string | null): Partial<Prefs> {
	if (stored === null) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(stored);
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {};
	}
	const record = parsed as Record<string, unknown>;
	const out: { -readonly [K in PrefKey]?: boolean } = {};
	for (const key of Object.keys(DEFAULT_PREFS) as readonly PrefKey[]) {
		if (typeof record[key] === "boolean") {
			out[key] = record[key] as boolean;
		}
	}
	return out;
}

export interface PrefsState {
	readonly prefs: Prefs;
	/** Set one pref; the others (and any unknown stored fields) persist. */
	setPref<K extends PrefKey>(key: K, value: Prefs[K]): void;
}

export function usePrefs(options?: {
	readonly storage?: PrefsStorage;
}): PrefsState {
	const storage = options?.storage ?? defaultStorage();
	const [stored, setStored] = useState<Partial<Prefs>>(() =>
		parseStored(storage.getItem(PREFS_STORAGE_KEY)),
	);

	return {
		prefs: { ...DEFAULT_PREFS, ...stored },
		setPref(key, value) {
			setStored((previous) => {
				// The stored document keeps only explicitly-set fields, so a
				// default change later reaches users who never touched it.
				const next = { ...previous, [key]: value };
				storage.setItem(PREFS_STORAGE_KEY, JSON.stringify(next));
				return next;
			});
		},
	};
}
