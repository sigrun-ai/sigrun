import { describe, expect, it, test } from "vitest";
import {
	MAX_SUFFIX_ATTEMPTS,
	MAX_USERNAME_LENGTH,
	UsernameExhaustedError,
	deriveUsername,
	foldSubject,
	isUsernameKey,
	withSuffix,
} from "@sigrun/shared/usernames";

const INPUT_COUNT = 20_000;
const INPUT_ALPHABET = [
	..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
	".",
	"_",
	"-",
	"@",
	" ",
	"+",
	"\\",
	"K",
	"\u212A",
	"\u0130",
	"\u0131",
	"\u017F",
	"ß",
	"ﬁ",
	"Ａ",
	"é",
	"e\u0301",
];
const KEY_BODY_ALPHABET = [..."abcdefghijklmnopqrstuvwxyz0123456789._-"];
const KEY_START_ALPHABET = [..."abcdefghijklmnopqrstuvwxyz0123456789"];

function randomGenerator(seed: number): () => number {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function generateCorpus(): { inputs: string[]; validKeys: string[] } {
	const random = randomGenerator(0x53494752);
	const inputs: string[] = [];
	const validKeys: string[] = [];
	for (let index = 0; index < INPUT_COUNT; index += 1) {
		const inputLength = Math.floor(random() * 161);
		let input = "";
		for (let character = 0; character < inputLength; character += 1) {
			input += INPUT_ALPHABET[Math.floor(random() * INPUT_ALPHABET.length)];
		}
		inputs.push(input);

		const keyLength = 1 + Math.floor(random() * MAX_USERNAME_LENGTH);
		let key = KEY_START_ALPHABET[Math.floor(random() * KEY_START_ALPHABET.length)];
		for (let character = 1; character < keyLength; character += 1) {
			key += KEY_BODY_ALPHABET[Math.floor(random() * KEY_BODY_ALPHABET.length)];
		}
		validKeys.push(key);
	}
	return { inputs, validKeys };
}

const { inputs, validKeys } = generateCorpus();

test.each([
	["michaelmacleod", "michaelmacleod"],
	["Mike", "mike"],
	["mike@example.ca", "mike_example.ca"],
	["mike@example.com", "mike_example.com"],
	["Mike.Smith@Example.COM", "mike.smith_example.com"],
	["mike+test@example.com", "mike-test_example.com"],
	["José García", "jose-garcia"],
	["DOMAIN\\mike", "domain-mike"],
	["Alice Smith", "alice-smith"],
	[".hidden", "hidden"],
	["mike.", "mike."],
	["", undefined],
	["@@@", undefined],
])("deriveUsername(%j) returns %j", (input, expected) => {
	expect(deriveUsername(input)).toBe(expected);
});

describe("username derivation properties", () => {
	it("produces only valid keys when defined", () => {
		for (const input of inputs) {
			const derived = deriveUsername(input);
			if (derived !== undefined) {
				expect(isUsernameKey(derived), JSON.stringify(input)).toBe(true);
			}
		}
	});

	it("is idempotent", () => {
		for (const input of inputs) {
			const derived = deriveUsername(input);
			const twice = derived === undefined ? undefined : deriveUsername(derived);
			expect(twice, JSON.stringify(input)).toBe(derived);
		}
	});

	it("keeps every generated valid key as a fixed point", () => {
		for (const key of validKeys) {
			expect(isUsernameKey(key)).toBe(true);
			expect(deriveUsername(key)).toBe(key);
		}
	});

	it("agrees with NFC-folded subjects that are already valid keys", () => {
		for (const header of inputs) {
			const folded = foldSubject(header);
			if (isUsernameKey(folded)) {
				expect(deriveUsername(header), JSON.stringify(header)).toBe(folded);
			}
		}
	});
});

describe("username keys", () => {
	it("enforces the 128-character boundary", () => {
		expect(isUsernameKey("a".repeat(MAX_USERNAME_LENGTH))).toBe(true);
		expect(isUsernameKey("a".repeat(MAX_USERNAME_LENGTH + 1))).toBe(false);
	});

	it("truncates a 300-character input to 128 characters", () => {
		expect(deriveUsername("a".repeat(300))).toHaveLength(MAX_USERNAME_LENGTH);
	});
});

describe("withSuffix", () => {
	it("uses the base first, then numeric suffixes", () => {
		expect(withSuffix("user", (key) => key === "user")).toBe("user-2");
	});

	it("truncates the base to keep a suffixed key within 128 characters", () => {
		const base = "a".repeat(MAX_USERNAME_LENGTH);
		const result = withSuffix(base, (key) => key === base);
		expect(result).toBe(`${"a".repeat(126)}-2`);
		expect(result).toHaveLength(MAX_USERNAME_LENGTH);
	});

	it("throws after exhausting suffix attempts", () => {
		expect(() => withSuffix("user", () => true)).toThrow(UsernameExhaustedError);
		expect(MAX_SUFFIX_ATTEMPTS).toBe(10_000);
	});
});
