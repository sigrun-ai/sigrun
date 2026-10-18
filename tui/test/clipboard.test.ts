/**
 * OSC 52 clipboard (Task C3): the bare sequence, the tmux DCS wrap, and
 * copyToTerminal's write.
 */

import { describe, expect, test } from "vitest";
import { copyToTerminal, osc52 } from "../src/clipboard.js";

describe("osc52", () => {
	test("bare terminal: OSC 52 with base64 utf8 and BEL terminator", () => {
		expect(osc52("hi", {})).toBe("\x1b]52;c;aGk=\x07");
	});

	test("encodes UTF-8 (not latin1)", () => {
		// "héllo" — the é must survive as its two-byte UTF-8 form.
		expect(osc52("héllo", {})).toBe(
			`\x1b]52;c;${Buffer.from("héllo", "utf8").toString("base64")}\x07`,
		);
	});

	test("tmux: DCS-wrapped with every ESC doubled", () => {
		const bare = osc52("hi", {});
		const wrapped = osc52("hi", { TMUX: "/tmp/tmux-1000/default,1,0" });
		expect(wrapped).toBe(
			`\x1bPtmux;\x1b${bare.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`,
		);
	});

	test("empty TMUX does not wrap", () => {
		expect(osc52("hi", { TMUX: "" })).toBe("\x1b]52;c;aGk=\x07");
	});
});

describe("copyToTerminal", () => {
	test("writes the sequence to the terminal", () => {
		const written: string[] = [];
		copyToTerminal({ write: (data) => written.push(data) }, "hi", {});
		expect(written).toEqual(["\x1b]52;c;aGk=\x07"]);
	});
});
