/**
 * The backup last-success marker (core-hardening §6.8, R15 — "backup
 * honesty"): `run-backup.ts` stamps `<stateDir>/backup/last-success.json`
 * after a successful run, and `GET /v1/meta` reads it PER REQUEST to
 * derive `health.backup` — before this, a configured-but-silently-failing
 * CronJob still reported "configured" (the badge lied).
 *
 * Read posture: the marker is observability, never a gate. An absent,
 * unreadable, unparseable, or wrong-shape marker reads as `undefined`
 * — which DERIDES health ("degraded") but never fails the request. A
 * corrupt marker must cost the badge, not the endpoint.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../harness/stores.js";

/** The marker's directory + filename under the state root. */
export const BACKUP_MARKER_DIR = "backup";
export const BACKUP_MARKER_NAME = "last-success.json";

/** The marker's shape (§6.8): when, to which target kind, how big. */
export interface BackupMarker {
	/** ISO timestamp of the successful run. */
	readonly at: string;
	/** Which target shape the run shipped to. */
	readonly target: "path" | "s3";
	/** The shipped db backup's size in bytes. */
	readonly bytes: number;
}

/** The marker's path under a state root. */
export function backupMarkerPath(stateDir: string): string {
	return join(stateDir, BACKUP_MARKER_DIR, BACKUP_MARKER_NAME);
}

/**
 * Write the marker: mkdir the `backup/` dir, then atomic-replace with
 * mode 0644 (an operator file — unlike secrets, nothing in it is
 * sensitive; 0644 keeps `kubectl exec … cat` and restores simple).
 */
export async function writeBackupMarker(
	stateDir: string,
	marker: BackupMarker,
): Promise<void> {
	await mkdir(join(stateDir, BACKUP_MARKER_DIR), { recursive: true });
	await writeFileAtomic(
		backupMarkerPath(stateDir),
		`${JSON.stringify(marker, null, "\t")}\n`,
		0o644,
	);
}

/** Structural check: every field present and correctly typed — `at`
 * must PARSE as a timestamp too (a marker whose `at` is garbage reads as
 * no marker: surfacing an unparseable `lastSuccessAt` on the wire would
 * trade a honest degraded badge for a confusing one). */
function isBackupMarker(value: unknown): value is BackupMarker {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.at === "string" &&
		Number.isFinite(Date.parse(record.at)) &&
		(record.target === "path" || record.target === "s3") &&
		typeof record.bytes === "number" &&
		Number.isFinite(record.bytes)
	);
}

/**
 * Read the marker from a state root. `undefined` when absent (ENOENT) —
 * and when anything else is wrong with it (unreadable, unparseable,
 * wrong shape): a marker that cannot be trusted must not read as a
 * success.
 */
export async function readBackupMarker(
	stateDir: string,
): Promise<BackupMarker | undefined> {
	let raw: string;
	try {
		raw = await readFile(backupMarkerPath(stateDir), "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	return isBackupMarker(parsed) ? parsed : undefined;
}

/**
 * Whether a marker is stale: `now - at` strictly beyond
 * `staleAfterHours` hours. A marker whose `at` does not parse as a
 * timestamp is stale by definition (the derivation never surfaces it,
 * but the pure rule stays total).
 */
export function isBackupMarkerStale(
	marker: BackupMarker,
	staleAfterHours: number,
	now = Date.now(),
): boolean {
	const at = Date.parse(marker.at);
	if (!Number.isFinite(at)) return true;
	return now - at > staleAfterHours * 60 * 60 * 1000;
}
