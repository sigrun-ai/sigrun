export type ScanRule = "credential" | "injection" | "exfiltration";
export type ScanResult = { ok: true } | { ok: false; line: number; rule: ScanRule };

/** Deliberately conservative: learned text is instructions, not a secret store. */
const RULES: Readonly<Record<ScanRule, readonly RegExp[]>> = {
	credential: [
		/\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[a-z0-9_-]{12,}/i,
		/\bsk-[a-z0-9_-]{12,}/i,
		/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
	],
	injection: [
		/\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+instructions\b/i,
		/\bdisregard\s+(?:all\s+)?(?:previous|prior)\s+instructions\b/i,
		/\bsystem\s+prompt\s*:\s*you\s+(?:are|must)\b/i,
	],
	exfiltration: [
		/\b(?:send|upload|post|transmit)\b[^\n]*(?:~\/\.ssh|\/etc\/passwd|credentials?|secrets?)[^\n]*https?:\/\//i,
		/\b(?:curl|wget)\b[^\n]*(?:~\/\.ssh|\/etc\/passwd|credentials?|secrets?)/i,
	],
};

const ORDER: readonly ScanRule[] = ["credential", "injection", "exfiltration"];

/** Scan line-by-line so a refusal can name the exact line to revise. */
export function scanContent(text: string): ScanResult {
	const lines = text.split(/\r?\n/);
	for (const rule of ORDER) {
		for (let index = 0; index < lines.length; index++) {
			if (RULES[rule].some((pattern) => pattern.test(lines[index]))) {
				return { ok: false, line: index + 1, rule };
			}
		}
	}
	return { ok: true };
}
