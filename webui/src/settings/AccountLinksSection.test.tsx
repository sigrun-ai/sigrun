import { act } from "react";
import { describe, expect, test } from "vitest";
import { ApiError, createClient, type FetchLike } from "../api";
import { renderAsync, textContent } from "../test-utils";
import { AccountLinksSection } from "./AccountLinksSection";

function makeHarness(options?: { readonly removeFails?: boolean }) {
	const calls: { input: string; method?: string; body?: string | Uint8Array }[] = [];
	let accounts = [{
		provider: "login:oauth:github",
		subject: "subject/123+test@example.invalid",
		user: "alice",
		linkedAt: 123,
		via: "login",
	}];
	const fetchImpl: FetchLike = (input, init) => {
		calls.push({ input, method: init?.method, body: init?.body });
		let body: unknown;
		if (input === "/v1/auth/accounts") body = { accounts };
		else if (input === "/v1/auth/providers") body = { providers: [
			{ provider: "login:oauth:github", label: "GitHub" },
			{ provider: "login:oauth:corp", label: "Example SSO" },
		] };
		else if (input.startsWith("/v1/auth/accounts?provider=")) {
			if (options?.removeFails === true) {
				return Promise.reject(new ApiError({ method: "DELETE", path: "/v1/auth/accounts", status: 403, error: "forbidden" }));
			}
			accounts = [];
			return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(undefined), text: () => Promise.resolve("") });
		} else throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${input}`);
		return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
	};
	return { calls, accounts: () => accounts, client: createClient({ fetch: fetchImpl }) };
}

describe("AccountLinksSection", () => {
	test("lists links, connects every provider, and removes a link", async () => {
		const harness = makeHarness();
		const renderer = await renderAsync(<AccountLinksSection client={harness.client} />);
		expect(textContent(renderer.toJSON())).toContain("subject/123+test@example.invalid");
		const connect = renderer.root.findAllByProps({ className: "account-connect" });
		expect(connect.map((node) => node.props.href)).toEqual([
			"/v1/auth/login/login%3Aoauth%3Agithub?link=1&return=%2Fsettings%3Fsection%3Daccounts",
			"/v1/auth/login/login%3Aoauth%3Acorp?link=1&return=%2Fsettings%3Fsection%3Daccounts",
		]);
		expect(connect.map((node) => node.children.join(""))).toEqual(["Connect", "Connect"]);
		await act(async () => {
			await renderer.root.findByProps({ className: "account-remove" }).props.onClick();
		});
		const removal = harness.calls.find((call) => call.method === "DELETE");
		expect(removal?.input).toBe("/v1/auth/accounts?provider=login%3Aoauth%3Agithub&subject=subject%2F123%2Btest%40example.invalid");
		expect(harness.accounts()).toEqual([]);
		expect(renderer.root.findAllByProps({ className: "account-remove" })).toHaveLength(0);
	});

	test("a failed removal preserves the link and Connect controls and shows the error inline", async () => {
		const harness = makeHarness({ removeFails: true });
		const renderer = await renderAsync(<AccountLinksSection client={harness.client} />);
		await act(async () => {
			await renderer.root.findByProps({ className: "account-remove" }).props.onClick();
		});
		expect(renderer.root.findByProps({ role: "alert" }).props.children).toBe("forbidden");
		expect(textContent(renderer.toJSON())).toContain("subject/123+test@example.invalid");
		expect(renderer.root.findAllByProps({ className: "account-remove" })).toHaveLength(1);
		expect(renderer.root.findAllByProps({ className: "account-connect" })).toHaveLength(2);
		expect(harness.accounts()).toHaveLength(1);
	});
});
