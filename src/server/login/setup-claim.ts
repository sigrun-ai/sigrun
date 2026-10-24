import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashToken } from "../../harness/identity/tokens.js";
import { writeJson } from "../../harness/identity/json-store.js";

export interface SetupClaim {
	readonly user: string;
	readonly provider: string;
	readonly subject: string;
	readonly codeSha256: string;
}

/**
 * A durable breadcrumb for the one setup-code-paid claim. It lets a retry
 * finish a crashed link without ever inferring ownership from a username.
 */
export class SetupClaimStore {
	readonly #path: string | undefined;
	#memory: SetupClaim | undefined;

	constructor(cacheDir?: string) {
		this.#path = cacheDir === undefined ? undefined : join(cacheDir, "login-setup-claim.json");
	}

	read(): SetupClaim | undefined {
		if (this.#path === undefined) return this.#memory;
		try {
			const value: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
			if (typeof value !== "object" || value === null) throw new Error("not an object");
			const record = value as Partial<SetupClaim>;
			if (
				typeof record.user !== "string" || typeof record.provider !== "string" ||
				typeof record.subject !== "string" || typeof record.codeSha256 !== "string"
			) throw new Error("invalid fields");
			return record as SetupClaim;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw new Error(`sigrun: malformed login setup claim in ${this.#path}`, { cause: error });
		}
	}

	async record(claim: SetupClaim): Promise<void> {
		if (this.#path === undefined) {
			this.#memory = claim;
			return;
		}
		await writeJson(this.#path, claim);
	}

	matches(provider: string, subject: string, code: string): SetupClaim | undefined {
		const claim = this.read();
		return claim?.provider === provider && claim.subject === subject && claim.codeSha256 === hashToken(code)
			? claim
			: undefined;
	}

	async clear(): Promise<void> {
		if (this.#path === undefined) {
			this.#memory = undefined;
			return;
		}
		const { rm } = await import("node:fs/promises");
		await rm(this.#path, { force: true });
	}
}
