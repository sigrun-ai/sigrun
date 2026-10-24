/**
 * The account-link store (multi-user M3a, spec §11.3): ONE
 * `<configDir>/accounts.json` linking external identities to directory
 * users — chat senders (`chat:<channel>`, written by the gateway) and
 * login subjects (`login:<slug>:<id>`, written by the login routes) in
 * the same table.
 *
 * It lives in CORE, not in an extension, for one reason: an extension
 * runs inside sigrun's process, so a link table owned by an extension
 * is a second write path to the same identity data. Core owns the file,
 * extensions go through `host.accounts`, and the gateway and the login
 * seam cannot disagree about who a sender is.
 *
 * A link is refused, never re-pointed, when `(provider, subject)` is
 * already linked to a DIFFERENT user: re-pointing an existing external
 * identity is an account-takeover path (an attacker who controls the
 * other side of a stale link would inherit the account). The holder or
 * an admin removes the old link first. Re-linking to the SAME user is a
 * no-op that returns the existing record.
 *
 * Store discipline is `users.json`'s (`json-store.ts`): synchronous
 * mtime-reloading reads, atomic 0600 writes, mutations serialized on a
 * per-instance {@link MutationQueue}. The CLI is a second writer and is
 * honored live.
 */

import { MutationQueue, readRecords, writeJson } from "./json-store.js";
import type { UserDirectory } from "./users.js";

/** How a link came to exist (spec §11.3). */
export type AccountLinkVia = "login" | "self" | "pairing" | "admin";

/** One external identity bound to one directory user. */
export interface AccountLink {
	/** `chat:<channel>` or `login:<slug>:<id>` (spec §11.3). */
	readonly provider: string;
	/** The provider's stable subject: numeric id, `+E.164`, email-shaped, … */
	readonly subject: string;
	/** The directory user this identity acts as. */
	readonly user: string;
	/** Epoch ms. */
	readonly linkedAt: number;
	readonly via: AccountLinkVia;
}

/**
 * A `(provider, subject)` already linked to a different user. The
 * message never names the current holder — the caller learns only that
 * the identity is taken (extensions match on the
 * `account_link_conflict:` prefix, like `command_not_found:`).
 */
export class AccountLinkConflictError extends Error {
	readonly provider: string;
	readonly subject: string;

	constructor(provider: string, subject: string) {
		super(`account_link_conflict: ${provider} is linked to another user`);
		this.name = "AccountLinkConflictError";
		this.provider = provider;
		this.subject = subject;
	}
}

/** `chat:<channel>` / `login:<slug>:<id>` — lowercase, no spaces. */
const PROVIDER_PATTERN = /^(login|chat):[a-z0-9][a-z0-9._:-]*$/;

/** A subject is opaque, non-empty, and bounded. */
const SUBJECT_MAX_LENGTH = 512;

/**
 * The file-backed link table. Reads are synchronous (mtime reload per
 * access); every mutation is a whole-file read-modify-write serialized
 * on the store's {@link MutationQueue}, with validation INSIDE the
 * mutation so the user-existence and conflict checks see the same file
 * state as the write.
 */
export class AccountStore {
	private readonly mutations = new MutationQueue();

	constructor(
		private readonly path: string,
		private readonly users: UserDirectory,
	) {}

	/** Every link, insertion order. */
	list(): AccountLink[] {
		return readRecords<AccountLink>(this.path);
	}

	/** The link for one external identity; absent → undefined. */
	lookup(provider: string, subject: string): AccountLink | undefined {
		return this.list().find(
			(link) => link.provider === provider && link.subject === subject,
		);
	}

	/** One user's links, insertion order. */
	listForUser(user: string): AccountLink[] {
		return this.list().filter((link) => link.user === user);
	}

	/**
	 * Link an external identity to a directory user. Same-user re-link is
	 * a no-op returning the existing record (its `via` and `linkedAt` are
	 * the first link's); a different user is refused with
	 * {@link AccountLinkConflictError}. Throws `unknown user "<user>"`,
	 * `invalid_provider: <provider>`, or `invalid_subject`.
	 */
	link(input: {
		provider: string;
		subject: string;
		user: string;
		via: AccountLinkVia;
	}): Promise<AccountLink> {
		return this.mutations.run(async () => {
			const { provider, subject, user, via } = input;
			if (!PROVIDER_PATTERN.test(provider)) {
				throw new Error(`invalid_provider: ${provider}`);
			}
			if (subject === "" || subject.length > SUBJECT_MAX_LENGTH) {
				throw new Error("invalid_subject");
			}
			if (this.users.get(user) === undefined) {
				throw new Error(`unknown user "${user}"`);
			}
			const records = this.list();
			const existing = records.find(
				(link) => link.provider === provider && link.subject === subject,
			);
			if (existing !== undefined) {
				if (existing.user !== user) {
					throw new AccountLinkConflictError(provider, subject);
				}
				return existing;
			}
			const record: AccountLink = {
				provider,
				subject,
				user,
				linkedAt: Date.now(),
				via,
			};
			records.push(record);
			await writeJson(this.path, records);
			return record;
		});
	}

	/** Remove one link; `false` when it was not there. */
	unlink(provider: string, subject: string): Promise<boolean> {
		return this.mutations.run(async () => {
			const records = this.list();
			const index = records.findIndex(
				(link) => link.provider === provider && link.subject === subject,
			);
			if (index === -1) return false;
			records.splice(index, 1);
			await writeJson(this.path, records);
			return true;
		});
	}

	/**
	 * Remove every link of one user (user deletion, spec §10.6 step 1).
	 * Links never transfer: credentials belong to a person.
	 */
	removeUser(user: string): Promise<number> {
		return this.mutations.run(async () => {
			const records = this.list();
			const kept = records.filter((link) => link.user !== user);
			const removed = records.length - kept.length;
			if (removed === 0) return 0;
			await writeJson(this.path, kept);
			return removed;
		});
	}
}
