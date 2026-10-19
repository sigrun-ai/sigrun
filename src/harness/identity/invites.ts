/**
 * The invite store (core hardening W1 Task 2, spec §5.8): ONE
 * `invites.json` under the state root — admin-issued single-use codes
 * that admit one directory user each.
 *
 - codes are the setup-code alphabet shape (`XXXX-XXXX`) but UNPINNED
   by any env var — every `create` draws a fresh one;
 - only the SHA-256 digest is stored (the same `hashToken` discipline
   as tokens — a leaked file admits no one);
 - single-use: a redeemed row keeps its `usedBy` FOREVER (Review
   Focus 4) — an expired redeem returns undefined without touching the
   row, and a used row past its expiry stays used, never re-openable;
 - expiry compares epoch-ms `expiresAt` against the (injectable) now,
   so clock-skewed cases are testable;
 - mode `0600`, atomic writes, mtime-reload reads, mutating calls
   serialized on the store's {@link MutationQueue} — two concurrent
   redeems of one code yield exactly one success.
 *
 * The SETUP CODE is deliberately not a row here: it lives under the
 * cache root (never a backup section) and is compared directly. It is
 * the first invite only as a behavioral equivalence — it admits one
 * admin claim.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { generateCode } from "./setup-code.js";
import { hashToken } from "./tokens.js";
import { MutationQueue, readRecords, writeJson } from "./json-store.js";

/** Default invite expiry: 7 days in ms (spec §5.8). */
export const DEFAULT_INVITE_EXPIRY_MS = 604_800_000;

/** One stored invite — the digest, the grant, the expiry, the use. */
export interface InviteRecord {
	readonly id: string;
	readonly sha256: string;
	/** Whether the redeem grants the user admin. */
	readonly admin: boolean;
	/** Epoch-ms expiry instant (exclusive-boundary: `now > expiresAt` is expired). */
	readonly expiresAt: number;
	/** The username that redeemed this code; undefined while unused. */
	readonly usedBy?: string;
}

/** Constant-time digest equality (delegates to the token discipline). */
function matchesCode(record: InviteRecord, digest: string): boolean {
	if (record.sha256.length !== digest.length) return false;
	return timingSafeEqual(
		Buffer.from(record.sha256, "hex"),
		Buffer.from(digest, "hex"),
	);
}

/**
 * The file-backed invite store. `redeem` is the single mutator; both
 * methods serialize on the store's {@link MutationQueue}.
 */
export class InviteStore {
	private readonly mutations = new MutationQueue();

	constructor(private readonly path: string) {}

	private list(): InviteRecord[] {
		return readRecords<InviteRecord>(this.path);
	}

	/**
	 * Issue one invite: draws a fresh code, stores only its digest plus
	 * the grant and expiry (`expiresInMs` defaults to 7 days), and
	 * returns `{id, code}` — the code is shown once, by the caller.
	 */
	create(opts: {
		admin: boolean;
		expiresInMs?: number;
	}): Promise<{ id: string; code: string }> {
		return this.mutations.run(async () => {
			const code = generateCode();
			const record: InviteRecord = {
				id: randomUUID(),
				sha256: hashToken(code),
				admin: opts.admin,
				expiresAt:
					Date.now() + (opts.expiresInMs ?? DEFAULT_INVITE_EXPIRY_MS),
			};
			await writeJson(this.path, [...this.list(), record]);
			return { id: record.id, code };
		});
	}

	/**
	 * Redeem one code for `user`: undefined when no record matches the
	 * digest, when the row is already used (single-use, forever), or
	 * when `now` is past `expiresAt` — and in every undefined case the
	 * row is left untouched (an expired-but-unused invite is not marked,
	 * a used row keeps its `usedBy` past expiry). A success stamps
	 * `usedBy` atomically and returns the grant.
	 */
	redeem(
		code: string,
		user: string,
		now: number = Date.now(),
	): Promise<{ admin: boolean } | undefined> {
		return this.mutations.run(async () => {
			const records = this.list();
			const digest = hashToken(code);
			const index = records.findIndex((record) => matchesCode(record, digest));
			const record = index === -1 ? undefined : records[index];
			if (record === undefined) return undefined;
			if (record.usedBy !== undefined) return undefined;
			if (now > record.expiresAt) return undefined;
			records[index] = { ...record, usedBy: user };
			await writeJson(this.path, records);
			return { admin: record.admin };
		});
	}
}
