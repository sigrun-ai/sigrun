/**
 * The shared helper-launch shape (src/sandbox/launch.ts): one writer for
 * the `SIGRUN_SANDBOX_POLICY` payload every producer uses, so the wire
 * contract (sandbox/src/policy.rs, `deny_unknown_fields`) cannot drift
 * between the worker/service launch path and out-of-tree consumers such
 * as the smoke-image jailed check.
 */

import { describe, expect, test } from "vitest";
import { launchInJail, serializePolicy } from "../src/sandbox/launch.js";
import type { UserPolicy } from "../src/sandbox/policy.js";

/** A minimal complete policy (the fields buildUserPolicy always sets). */
function policy(extra?: Partial<UserPolicy>): UserPolicy {
	return {
		user: "acme",
		workspace: "/data/workspace",
		home: "/data/users/acme",
		tmp: "/data/state/sandbox/acme/tmp",
		ro: ["/app"],
		rw: ["/data/workspace", "/data/users/acme"],
		env: { HOME: "/data/users/acme" },
		ensureDirs: ["/data/users/acme"],
		...extra,
	};
}

describe("serializePolicy", () => {
	test("serializes the helper wire shape with minAbi 6, omitting absent ids", () => {
		const parsed = JSON.parse(serializePolicy(policy())) as Record<string, unknown>;
		expect(parsed).toEqual({
			ro: ["/app"],
			rw: ["/data/workspace", "/data/users/acme"],
			ensureDirs: ["/data/users/acme"],
			minAbi: 6,
		});
		// Absent uid/gid/groups are OMITTED, never null — the helper's
		// Option fields deserialize from absence only.
		expect("uid" in parsed).toBe(false);
		expect("gid" in parsed).toBe(false);
		expect("groups" in parsed).toBe(false);
	});

	test("carries uid/gid/groups when the policy maps an OS account", () => {
		const parsed = JSON.parse(
			serializePolicy(policy({ uid: 1001, gid: 1001, groups: [1001, 1002] })),
		) as Record<string, unknown>;
		expect(parsed).toMatchObject({ uid: 1001, gid: 1001, groups: [1001, 1002] });
	});
});

describe("launchInJail", () => {
	test("execs the helper over the serialized policy and the tmp openssl config", () => {
		const built = launchInJail(
			"/opt/sigrun-sandbox",
			policy(),
			"node",
			["worker.js"],
			{ EXTRA: "1" },
		);
		expect(built.command).toBe("/opt/sigrun-sandbox");
		expect(built.args).toEqual(["run", "--", "node", "worker.js"]);
		expect(built.env.EXTRA).toBe("1");
		expect(built.env.OPENSSL_CONF).toBe("/data/state/sandbox/acme/tmp/openssl.cnf");
		// The payload is serializePolicy's — verbatim.
		expect(built.env.SIGRUN_SANDBOX_POLICY).toBe(serializePolicy(policy()));
	});
});
