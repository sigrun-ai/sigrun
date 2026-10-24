/**
 * The user directory (core hardening W1 Task 2, spec §5.8): ONE
 * `users.json` at the config root — the identity source for owner
 * stamping, share pickers, and admin checks. Mode `0600` (it holds
 * emails), atomic writes, mtime-reload reads (the shared json-store
 * discipline — the CLI is a second writer, honored live).
 *
 * `user` matches `^[a-z0-9][a-z0-9._-]*$` and is IMMUTABLE — the
 * identity other records key on; renames are delete + add by design.
 * The server is unclaimed while the directory is empty and claimed
 * after the first add (`isClaimed`); `admin` is a property of the USER
 * (tokens carry their user's rights — never their own admin flag).
 */

import { MutationQueue, readRecords, writeJson } from "./json-store.js";
import type { Grant } from "../../sandbox/grants.js";

/** The username rule (spec §5.8): lowercase-first, then `[a-z0-9._-]`. */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** One directory user (spec §5.8 entry shape, verbatim). */
export interface DirectoryUser {
	/** The immutable username key; also the identity other records stamp. */
	readonly user: string;
	readonly name?: string;
	readonly email?: string;
	/** Configuration authority lives with the user, never with a token. */
	readonly admin: boolean;
	/**
	 * The proxy-group admin grant (gateway C8): the request pipeline's
	 * write-through at proxy-authenticated requests, present only while
	 * `server.auth.adminGroups` is configured. NEVER grants authority on
	 * its own in the directory (the admin routes' guards read stored
	 * `admin`); host-side surfaces project it into effective admin.
	 */
	readonly groupAdmin?: boolean;
	/** The user's realpath-validated workspace (multi-user M1 §9.5). */
	readonly workspace?: string;
	/** Additional realpath-validated directories available to their worker. */
	readonly grants?: readonly Grant[];
	/** Optional bare-metal OS login used by the worker's uid/gid switch. */
	readonly osUser?: string;
	/** When this record was created (epoch ms). */
	readonly createdAt: number;
	/** How the user entered the directory (spec §5.8 sources). */
	readonly source: "proxy" | "invite" | "cli";
}

/**
 * The file-backed user directory. Reads are synchronous (mtime reload
 * per access); every mutation is a whole-file read-modify-write that
 * serializes on the store's {@link MutationQueue}.
 */
export class UserDirectory {
	private readonly mutations = new MutationQueue();

	constructor(private readonly path: string) {}

	/** Every user, insertion order (the first add is the onboarding claim). */
	list(): DirectoryUser[] {
		return readRecords<DirectoryUser>(this.path);
	}

	/** One user by exact username; absent → undefined. */
	get(user: string): DirectoryUser | undefined {
		return this.list().find((record) => record.user === user);
	}

	/** True once the first user exists — the server's claimed state. */
	isClaimed(): boolean {
		return this.list().length > 0;
	}

	/** How many users carry `admin` (invite-issuing route guards read it). */
	recordAdminCount(): number {
		return this.list().filter((record) => record.admin).length;
	}

	/**
	 * Add one user (spec §5.8): rejects an invalid username and a
	 * duplicate, both loud with the username named. `createdAt` is
	 * stamped here, never by the caller.
	 */
	add(user: Omit<DirectoryUser, "createdAt">): Promise<DirectoryUser> {
		return this.mutations.run(async () => {
			if (!USERNAME_PATTERN.test(user.user)) {
				throw new Error(
					`invalid username "${user.user}": must match ^[a-z0-9][a-z0-9._-]*$`,
				);
			}
			const records = this.list();
			if (records.some((record) => record.user === user.user)) {
				throw new Error(`user "${user.user}" already exists`);
			}
			const record: DirectoryUser = { ...user, createdAt: Date.now() };
			await writeJson(this.path, [...records, record]);
			return record;
		});
	}

	/**
	 * Patch one user's mutable fields (`name`/`email`/`admin` — the
	 * username itself is immutable; `groupAdmin` is the pipeline's own
	 * write-through field, never the PATCH route's surface). Absent user
	 * throws; the file is rewritten atomically.
	 */
	update(
		user: string,
		patch: {
			name?: string;
			email?: string;
			admin?: boolean;
			groupAdmin?: boolean;
			workspace?: string;
			grants?: readonly Grant[];
			osUser?: string;
		},
	): Promise<DirectoryUser> {
		return this.mutations.run(async () => {
			const records = this.list();
			const index = records.findIndex((record) => record.user === user);
			if (index === -1) {
				throw new Error(`unknown user "${user}"`);
			}
			const updated: DirectoryUser = { ...records[index], ...patch };
			records[index] = updated;
			await writeJson(this.path, records);
			return updated;
		});
	}

	/** Remove one user (their tokens are NOT revoked here — caller's job). */
	remove(user: string): Promise<void> {
		return this.mutations.run(async () => {
			const records = this.list();
			const index = records.findIndex((record) => record.user === user);
			if (index === -1) {
				throw new Error(`unknown user "${user}"`);
			}
			records.splice(index, 1);
			await writeJson(this.path, records);
		});
	}
}
