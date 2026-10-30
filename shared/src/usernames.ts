export const MAX_USERNAME_LENGTH = 128;
export const MAX_SUFFIX_ATTEMPTS = 10_000;

const COMBINING_MARKS = /\p{M}/gu;
const AT_SIGNS = /@/g;
const INVALID_CHARACTERS = /[^a-z0-9._-]/g;
const LEADING_NON_ALPHANUMERIC = /^[^a-z0-9]+/;
const USERNAME_KEY = /^[a-z0-9][a-z0-9._-]*$/;

export class UsernameExhaustedError extends Error {}

export function deriveUsername(input: string): string | undefined {
	const derived = input
		.normalize("NFKD")
		.replace(COMBINING_MARKS, "")
		.toLowerCase()
		.replace(AT_SIGNS, "_")
		.replace(INVALID_CHARACTERS, "-")
		.replace(LEADING_NON_ALPHANUMERIC, "")
		.slice(0, MAX_USERNAME_LENGTH);
	return derived === "" ? undefined : derived;
}

export function isUsernameKey(s: string): boolean {
	return s.length <= MAX_USERNAME_LENGTH && USERNAME_KEY.test(s);
}

export function foldSubject(s: string): string {
	return s.normalize("NFC").toLowerCase();
}

export function withSuffix(
	base: string,
	taken: (key: string) => boolean,
): string {
	if (!taken(base)) {
		return base;
	}
	for (let suffix = 2; suffix <= MAX_SUFFIX_ATTEMPTS; suffix += 1) {
		const suffixText = `-${suffix}`;
		const candidate = `${base.slice(0, MAX_USERNAME_LENGTH - suffixText.length)}${suffixText}`;
		if (!taken(candidate)) {
			return candidate;
		}
	}
	throw new UsernameExhaustedError(`No available username for "${base}"`);
}
