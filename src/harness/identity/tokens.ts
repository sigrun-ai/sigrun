/**
 * The API token store (core hardening W1 Task 2, spec §5.4): ONE
 * `api-tokens.json` at the config root — the bearer-credential surface
 * for TUI `attach`, scripts, and browser login.
 *
 - tokens are `sgr_` + base64url(32 random bytes) — shown ONCE at
   create, never persisted;
 - only the SHA-256 hex digest is stored (`sha256`), and verification
   compares digests with `timingSafeEqual` on equal-length buffers;
 - mode `0600`, atomic writes, mtime-reload reads (the CLI's
   `sigrun token` subcommands are a second writer, honored live);
 - `user` names the directory user whose rights the token carries —
   admin is a property of the user, never of the token.
 */

import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import { MutationQueue, readRecords, writeJson } from "./json-store.js";

/** The token wire prefix (the `sk-`/`sgr_` convention; spec §5.4). */
const TOKEN_PREFIX = "sgr_";

/** One stored token record — the digest, never the token itself. */
export interface TokenRecord {
	readonly id: string;
	readonly name: string;
	readonly user: string;
	readonly sha256: string;
	readonly createdAt: number;
}

/** A fresh token: `sgr_` + 32 random bytes in base64url (43 chars). */
export function generateToken(): string {
	return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** The stored form of a token: its SHA-256 hex digest. */
export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** Constant-time digest equality (equal-length buffers, spec §5.4). */
function sameDigest(stored: string, digest: string): boolean {
	if (stored.length !== digest.length) return false;
	return timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(digest, "hex"));
}

/**
 * The file-backed token store. Reads/verifications are synchronous
 * (mtime reload per access); creates/revokes serialize on the store's
 * {@link MutationQueue}.
 */
export class TokenStore {
	private readonly mutations = new MutationQueue();

	constructor(private readonly path: string) {}

	/** All records, or one user's with `user` given (no secrets exist to omit). */
	list(user?: string): TokenRecord[] {
		const records = readRecords<TokenRecord>(this.path);
		return user === undefined
			? records
			: records.filter((record) => record.user === user);
	}

	/**
	 * Verify a presented token: hash it, compare against every stored
	 * digest with `timingSafeEqual`. Absent/unknown/malformed → undefined.
	 */
	verify(token: string): TokenRecord | undefined {
		const digest = hashToken(token);
		return this.list().find((record) => sameDigest(record.sha256, digest));
	}

	/**
	 * Mint one token for `user`: generates the secret, stores ONLY its
	 * digest, and returns both — the token is shown once, by the caller.
	 */
	create(
		name: string,
		user: string,
	): Promise<{ record: TokenRecord; token: string }> {
		return this.mutations.run(async () => {
			const token = generateToken();
			const record: TokenRecord = {
				id: randomUUID(),
				name,
				user,
				sha256: hashToken(token),
				createdAt: Date.now(),
			};
			await writeJson(this.path, [...this.list(), record]);
			return { record, token };
		});
	}

	/** Revoke by record id; false when no such record existed. */
	revoke(id: string): Promise<boolean> {
		return this.mutations.run(async () => {
			const records = this.list();
			const index = records.findIndex((record) => record.id === id);
			if (index === -1) return false;
			records.splice(index, 1);
			await writeJson(this.path, records);
			return true;
		});
	}

	/** Revoke every token of one user (user removal's companion); returns the count. */
	revokeAllFor(user: string): Promise<number> {
		return this.mutations.run(async () => {
			const records = this.list();
			const kept = records.filter((record) => record.user !== user);
			const removed = records.length - kept.length;
			if (removed > 0) {
				await writeJson(this.path, kept);
			}
			return removed;
		});
	}
}
