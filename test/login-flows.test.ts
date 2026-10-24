import { expect, test } from "vitest";
import { LoginFlows, MAX_ACTIVE_LOGIN_FLOWS } from "../src/server/login/flows.js";

test("public begins cannot grow active or consumed login state without bound", () => {
	const flows = new LoginFlows();
	let oldestState = "";
	let newest: ReturnType<LoginFlows["start"]> | undefined;
	for (let index = 0; index < MAX_ACTIVE_LOGIN_FLOWS + 1; index += 1) {
		// Fill the consumed map too, so its capacity is independently bounded.
		const consumed = flows.start("login:fixture:provider", { returnTo: "/" });
		expect(flows.take(consumed.state, consumed.browserKey)).toBeDefined();
		const flow = flows.start("login:fixture:provider", { returnTo: "/" });
		if (index === 0) oldestState = flow.state;
		newest = flow;
	}
	expect(flows.size).toBe(MAX_ACTIVE_LOGIN_FLOWS);
	expect(flows.consumedSize).toBe(MAX_ACTIVE_LOGIN_FLOWS);
	expect(flows.take(oldestState, "wrong-key")).toBeUndefined();
	expect(newest).toBeDefined();
	expect(flows.take(newest!.state, newest!.browserKey)).toMatchObject({
		provider: "login:fixture:provider",
		state: newest!.state,
	});
});
