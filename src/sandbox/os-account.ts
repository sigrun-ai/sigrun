/** Resolve local OS accounts from text files, without native account modules. */

import { readFileSync } from "node:fs";

export interface OsAccount {
	readonly uid: number;
	readonly gid: number;
	readonly groups: number[];
	readonly home: string;
}

/** The synchronous file-reader shape used by both Node and fixture strings. */
export type OsAccountReader = (path: string) => string;

function fields(line: string): string[] | undefined {
	if (line === "" || line.startsWith("#")) return undefined;
	return line.split(":");
}

function id(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Find one login in passwd and collect its primary plus supplementary gids.
 * Missing, malformed, and root-linked records fail closed as `undefined`.
 */
export function lookupOsAccount(
	login: string,
	read: OsAccountReader = (path) => readFileSync(path, "utf8"),
): OsAccount | undefined {
	const passwd = read("/etc/passwd");
	let account:
		| { uid: number; gid: number; home: string }
		| undefined;
	for (const line of passwd.split(/\r?\n/)) {
		const parts = fields(line);
		if (parts === undefined || parts[0] !== login || parts.length < 7) continue;
		const uid = id(parts[2]);
		const gid = id(parts[3]);
		const home = parts[5];
		if (uid === undefined || gid === undefined || uid === 0 || gid === 0 || home === "") {
			return undefined;
		}
		account = { uid, gid, home };
		break;
	}
	if (account === undefined) return undefined;

	const groups = new Set<number>([account.gid]);
	for (const line of read("/etc/group").split(/\r?\n/)) {
		const parts = fields(line);
		if (parts === undefined || parts.length < 4) continue;
		const gid = id(parts[2]);
		if (gid === undefined || gid === 0) continue;
		const members = parts[3]!.split(",").map((member) => member.trim());
		if (members.includes(login)) groups.add(gid);
	}
	return { ...account, groups: [...groups] };
}
