/**
 * The agent shell environment (multi-user spec §8, the env-leak fix).
 *
 * pi-durable's `NodeExecutionEnv` runs commands with `{...process.env,
 * ...shellEnv, ...options.env}` unless a call passes `inheritEnv: false`,
 * and its bash tool always passes `inheritEnv: true`. So without this,
 * an agent's `env` prints sigrun's own environment: `SIGRUN_API_TOKEN`,
 * `SIGRUN_PROXY_SECRET`, and provider keys. `shellEnv` cannot fix it
 * (it merges over `process.env`, it never subtracts), so
 * {@link AgentExecutionEnv} forces every `exec` onto an allowlist built
 * from sigrun's environment, plus whatever the caller set explicitly.
 *
 * The allowlist is the spec's list plus two variables existing installs
 * depend on:
 * - `NPM_CONFIG_CACHE`: the image runs with a read-only root filesystem
 *   and points npm's cache at `/cache/npm`; without it `npm install` in
 *   an agent shell fails writing `~/.npm`.
 * - `SSH_AUTH_SOCK`: a socket path, not a secret; on a single-user
 *   workstation it is how the agent's `git push` reaches the operator's
 *   ssh-agent. The multi-user jail (spec §9) must not pass it to other
 *   users' workers.
 */

import type { Context } from "@earendil-works/chord";
import type {
	ExecutionError,
	Result,
	ShellExecOptions,
	ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/** Variables copied from sigrun's environment into every agent shell. */
export const AGENT_ENV_KEYS: readonly string[] = [
	"PATH",
	"HOME",
	"TMPDIR",
	"LANG",
	"TZ",
	"TERM",
	"USER",
	"LOGNAME",
	"SHELL",
	"NPM_CONFIG_CACHE",
	"SSH_AUTH_SOCK",
];

/** Locale variables (`LC_ALL`, `LC_CTYPE`, …) pass through by prefix. */
const AGENT_ENV_PREFIXES: readonly string[] = ["LC_"];

/** The allowlisted subset of `source` (defined values only). */
export function agentEnv(
	source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (
			AGENT_ENV_KEYS.includes(key) ||
			AGENT_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
		) {
			env[key] = value;
		}
	}
	return env;
}

/**
 * Upstream's local env with every command confined to {@link agentEnv}
 * plus the call's own `env`. `inheritEnv` is overridden whatever the
 * caller asked for: that flag is how the leak happens.
 */
export class AgentExecutionEnv extends NodeExecutionEnv {
	override exec(
		command: string | readonly string[],
		options: ShellExecOptions | undefined,
		context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		return super.exec(
			command,
			{ ...options, inheritEnv: false, env: { ...agentEnv(), ...options?.env } },
			context,
		);
	}
}
