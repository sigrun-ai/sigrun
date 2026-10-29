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

import { isUsernameKey } from "@sigrun/shared/usernames";
import { MutationQueue, readRecords, writeJson } from "./json-store.js";
import type { Grant } from "../../sandbox/grants.js";
import type { IsolationAvailability } from "../../sandbox/availability.js";
import type { SigrunConfig } from "../../config.js";

/** One directory user's groups from one authenticating source. */
export interface DirectoryGroups {
	readonly source: string;
	readonly values: readonly string[];
	readonly updatedAt: number;
}

/** One directory user (spec §5.8 entry shape, verbatim). */
export interface DirectoryUser {
	/** The immutable username key; also the identity other records stamp. */
	readonly user: string;
	readonly name?: string;
	readonly email?: string;
	/** Configuration authority lives with the user, never with a token. */
	readonly admin: boolean;
	/** Group memberships, replaced independently per authenticating source. */
	readonly groups?: readonly DirectoryGroups[];
	/** The user's realpath-validated workspace (multi-user M1 §9.5). */
	readonly workspace?: string;
	/** Additional realpath-validated directories available to their worker. */
	readonly grants?: readonly Grant[];
	/** Optional bare-metal OS login used by the worker's uid/gid switch. */
	readonly osUser?: string;
	/** When this record was created (epoch ms). */
	readonly createdAt: number;
	/** How the user entered the directory (spec §5.8 sources). */
	readonly source: "proxy" | "invite" | "cli" | "login";
}

/**
 * Strip the retired C8 field at every write boundary. A legacy on-disk
 * value is readable for compatibility, but never survives another write
 * and never participates in effective-admin derivation.
 */
function withoutLegacyGroupAdmin(record: DirectoryUser): DirectoryUser {
	const clean = { ...record } as DirectoryUser & { groupAdmin?: boolean };
	delete clean.groupAdmin;
	return clean;
}

/**
 * The file-backed user directory. Reads are synchronous (mtime reload
 * per access); every mutation is a whole-file read-modify-write that
 * serializes on the store's {@link MutationQueue}.
 */
export type AdmissionCode = "isolation_required" | "auth_required";

export class AdmissionRefusedError extends Error {
	constructor(readonly code: AdmissionCode, message: string) {
		super(message);
		this.name = "AdmissionRefusedError";
	}
}

/** The one multi-user admission policy shared by server boot and the CLI. */
export function createAdmissionGuard(opts: {
	isolation: IsolationAvailability;
	mode: SigrunConfig["isolation"]["mode"];
	methods: readonly ("token" | "proxy")[];
	proxySecretHeader: string | undefined;
}): (currentCount: number) => void {
	return () => {
		if (!opts.isolation.available || opts.mode === "off") {
			throw new AdmissionRefusedError(
				"isolation_required",
				`isolation_required: ${opts.isolation.reason ?? "isolation mode is off"}`,
			);
		}
		if (opts.methods.length === 0) {
			throw new AdmissionRefusedError(
				"auth_required",
				"auth_required: configure token or proxy authentication before adding another user",
			);
		}
		if (opts.methods.includes("proxy") && opts.proxySecretHeader === undefined) {
			throw new AdmissionRefusedError(
				"isolation_required",
				"isolation_required: proxy authentication requires server.auth.proxy.secretHeader before isolation can activate",
			);
		}
	};
}

export interface UserDirectoryOptions {
	/** Called in add's mutation before every non-first user is persisted. */
	readonly admit?: (currentCount: number) => void;
	/** The configured workspace stamped on the first record at the second add. */
	readonly firstWorkspace?: string;
}

export class UserDirectory {
	private readonly mutations = new MutationQueue();

	constructor(
		private readonly path: string,
		private options: UserDirectoryOptions = {},
	) {}

	/** Attach the process's admission policy (boot/CLI), preserving existing rows. */
	configureAdmission(options: UserDirectoryOptions): void {
		this.options = { ...this.options, ...options };
	}

	private async writeRecords(records: readonly DirectoryUser[]): Promise<void> {
		await writeJson(this.path, records.map(withoutLegacyGroupAdmin));
	}

	/** Run the shared admission guard before consuming an invite. Writes nothing. */
	checkAdmission(): void {
		this.checkAdmissionFor(this.list());
	}

	private checkAdmissionFor(records: readonly DirectoryUser[]): void {
		if (records.length >= 1) this.options.admit?.(records.length);
	}

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
			if (!isUsernameKey(user.user)) {
				throw new Error(
					`invalid username "${user.user}": must match ^[a-z0-9][a-z0-9._-]*$`,
				);
			}
			const records = this.list();
			if (records.some((record) => record.user === user.user)) {
				throw new Error(`user "${user.user}" already exists`);
			}
			if (records.length >= 1) {
				this.checkAdmissionFor(records);
				if (records.length === 1 && records[0]!.workspace === undefined && this.options.firstWorkspace !== undefined) {
					records[0] = { ...records[0], workspace: this.options.firstWorkspace };
				}
			}
			const record = withoutLegacyGroupAdmin({ ...user, createdAt: Date.now() });
			await this.writeRecords([...records, record]);
			return record;
		});
	}

	/**
	 * Patch one user's mutable fields (`name`/`email`/`admin` — the
	 * username itself is immutable). Absent user throws; the file is
	 * rewritten atomically and any legacy `groupAdmin` value is dropped.
	 */
	update(
		user: string,
		patch: {
			name?: string;
			email?: string;
			admin?: boolean;
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
			const updated = withoutLegacyGroupAdmin({ ...records[index]!, ...patch });
			records[index] = updated;
			await this.writeRecords(records);
			return updated;
		});
	}

	/**
	 * Replace one source's groups. Identical values are a true no-op:
	 * neither the file nor its mtime changes (busy proxy requests must
	 * not rewrite the directory). Other sources are preserved.
	 */
	setGroups(
		user: string,
		source: string,
		values: readonly string[],
		now = Date.now(),
	): Promise<DirectoryUser> {
		return this.mutations.run(async () => {
			const records = this.list();
			const index = records.findIndex((record) => record.user === user);
			if (index === -1) throw new Error(`unknown user "${user}"`);
			const current = records[index]!;
			const groups = [...(current.groups ?? [])];
			const sourceIndex = groups.findIndex((entry) => entry.source === source);
			const previous = sourceIndex === -1 ? undefined : groups[sourceIndex]!;
			if (
				previous !== undefined &&
				previous.values.length === values.length &&
				previous.values.every((value, i) => value === values[i])
			) {
				return current;
			}
			const entry = { source, values: [...values], updatedAt: now };
			if (sourceIndex === -1) groups.push(entry);
			else groups[sourceIndex] = entry;
			const updated = withoutLegacyGroupAdmin({ ...current, groups });
			records[index] = updated;
			await this.writeRecords(records);
			return updated;
		});
	}

	/**
	 * Remove one user and append a transfer grant to the recipient in one
	 * serialized read-modify-write. Current recipient grants are read inside
	 * the mutation, so a queued concurrent update cannot be clobbered.
	 */
	removeWithGrant(user: string, to: string, grant: Grant): Promise<void> {
		return this.mutations.run(async () => {
			const records = this.list();
			const sourceIndex = records.findIndex((record) => record.user === user);
			if (sourceIndex === -1) throw new Error(`unknown user "${user}"`);
			const recipientIndex = records.findIndex((record) => record.user === to);
			if (recipientIndex === -1) throw new Error(`unknown user "${to}"`);
			const recipient = records[recipientIndex]!;
			records[recipientIndex] = {
				...recipient,
				grants: [...(recipient.grants ?? []), grant],
			};
			records.splice(sourceIndex, 1);
			await this.writeRecords(records);
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
			await this.writeRecords(records);
		});
	}
}
