/** The shared helper launch shape for worker and per-user service processes. */

import type { UserPolicy } from "./policy.js";

export type LaunchService = (
	policy: UserPolicy,
	command: string,
	args: readonly string[],
	env: Readonly<Record<string, string>>,
) => JailLaunch;

export interface JailLaunch {
	command: string;
	args: string[];
	env: Record<string, string>;
}

/** Apply a complete policy in the helper, then exec the requested sibling process. */
export function launchInJail(
	helper: string,
	policy: UserPolicy,
	command: string,
	args: readonly string[],
	env: Readonly<Record<string, string>>,
): JailLaunch {
	return {
		command: helper,
		args: ["run", "--", command, ...args],
		env: {
			...env,
			// Node compiled with --openssl-shared-config auto-loads
			// $OPENSSLDIR/openssl.cnf at startup. On a package-managed
			// Node (Homebrew) that directory lives OUTSIDE every policy
			// prefix, and an unreadable config is a FATAL startup error —
			// the jailed worker cannot start node at all. The worker
			// policy grants tmp rw, so point the loader there; node does
			// not require the file to exist.
			OPENSSL_CONF: `${policy.tmp}/openssl.cnf`,
			SIGRUN_SANDBOX_POLICY: JSON.stringify({
				ro: policy.ro,
				rw: policy.rw,
				ensureDirs: policy.ensureDirs,
				minAbi: 6,
				...(policy.uid === undefined ? {} : { uid: policy.uid }),
				...(policy.gid === undefined ? {} : { gid: policy.gid }),
				...(policy.groups === undefined ? {} : { groups: policy.groups }),
			}),
		},
	};
}
