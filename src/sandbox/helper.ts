/** Locate the native sandbox helper without probing it. */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import type { Env } from "../config.js";

/**
 * Resolve in deployment precedence order: an explicit absolute env path,
 * the installed platform package, then this checkout's release build.
 * An unusable explicit path warns and falls through rather than aborting boot.
 */
export function resolveHelper(env: Env, coreRoot: string): string | undefined {
	const configured = env.SIGRUN_SANDBOX_HELPER;
	if (configured !== undefined && configured !== "") {
		if (isAbsolute(configured) && existsSync(configured)) return configured;
		console.warn(
			`SIGRUN_SANDBOX_HELPER is not an existing absolute path: ${configured}; falling back to installed or repo helper`,
		);
	}

	try {
		const platformPackage = `@sigrun/sandbox-linux-${process.arch}`;
		const require = createRequire(join(coreRoot, "package.json"));
		const helper = require.resolve(`${platformPackage}/bin/sigrun-sandbox`);
		if (existsSync(helper)) return helper;
	} catch {
		// The optional platform package is absent in a source-only install.
	}

	const repoHelper = join(
		coreRoot,
		"sandbox",
		"target",
		"release",
		"sigrun-sandbox",
	);
	return existsSync(repoHelper) ? repoHelper : undefined;
}
