import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createClient, type FetchLike } from "../api";
import { renderAsync } from "../test-utils";
import { Login, loginErrorCopy } from "./Login";

const PROVIDERS = {
	providers: [
		{ provider: "login:oauth:github", label: "GitHub" },
		{ provider: "login:oauth:corp", label: "Example SSO", icon: "key" },
	],
};

function makeClient() {
	const calls: { input: string; method?: string }[] = [];
	const fetchImpl: FetchLike = (input, init) => {
		calls.push({ input, method: init?.method });
		if (input !== "/v1/auth/providers") throw new Error(`unexpected fetch ${input}`);
		return Promise.resolve({
			ok: true,
			status: 200,
			json: () => Promise.resolve(PROVIDERS),
			text: () => Promise.resolve(JSON.stringify(PROVIDERS)),
		});
	};
	return { calls, client: createClient({ fetch: fetchImpl }) };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Login provider buttons", () => {
	test("renders one link per provider above the token form, with the return target preserved", async () => {
		vi.stubGlobal("location", {
			pathname: "/login",
			search: "?error=invalid_state",
			href: "http://localhost/login?error=invalid_state",
		});
		vi.stubGlobal("history", { replaceState: vi.fn() });
		const { client, calls } = makeClient();
		const renderer = await renderAsync(<Login client={client} onSuccess={() => {}} />);
		const links = renderer.root.findAllByProps({ className: "auth-provider" });
		expect(links.map((link) => [link.props.href, link.children.join("")])).toEqual([
			["/v1/auth/login/login%3Aoauth%3Agithub?return=%2F", "GitHub"],
			["/v1/auth/login/login%3Aoauth%3Acorp?return=%2F", "Example SSO"],
		]);
		const children = renderer.root.findByProps({ className: "auth-card" }).children;
		const providerIndex = children.findIndex((child) => typeof child === "object" && child !== null && "props" in child && child.props.className === "auth-providers");
		const tokenIndex = children.findIndex((child) => typeof child === "object" && child !== null && "props" in child && child.props.className === "auth-field");
		expect(providerIndex).toBeGreaterThanOrEqual(0);
		expect(providerIndex).toBeLessThan(tokenIndex);
		expect(renderer.root.findByProps({ "data-auth-field": "token" })).toBeDefined();
		expect(calls.map((call) => call.input)).toEqual(["/v1/auth/providers"]);
	});

	test("the token form still posts the token and reports success", async () => {
		vi.stubGlobal("location", { pathname: "/login", search: "", href: "http://localhost/login" });
		vi.stubGlobal("history", { replaceState: vi.fn() });
		const calls: { input: string; body?: string | Uint8Array }[] = [];
		const fetchImpl: FetchLike = (input, init) => {
			calls.push({ input, body: init?.body });
			const body = input === "/v1/auth/providers" ? { providers: [] } : { user: "alice" };
			return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve("") });
		};
		const onSuccess = vi.fn();
		const renderer = await renderAsync(<Login client={createClient({ fetch: fetchImpl })} onSuccess={onSuccess} />);
		await act(async () => {
			renderer.root.findByProps({ "data-auth-field": "token" }).props.onChange({ target: { value: " secret " } });
		});
		await act(async () => {
			await renderer.root.findByProps({ className: "auth-submit" }).props.onClick();
		});
		expect(JSON.parse(String(calls.find((call) => call.input === "/v1/auth/login")?.body))).toEqual({ token: "secret" });
		expect(onSuccess).toHaveBeenCalledOnce();
	});
});

describe("login error copy", () => {
	const cases = {
		invalid_state: "That sign-in link was already used or came from another browser. Start again.",
		login_expired: "This sign-in took too long or sigrun restarted. Start again.",
		not_allowed: "Your account isn't allowed to use this sigrun.",
		isolation_required: "This sigrun can't add another user yet. Ask the admin.",
		auth_required: "This sigrun can't add another user yet. Ask the admin.",
		account_link_conflict: "That account is already linked to another sigrun user.",
		provider_error: "The sign-in provider returned an error. Try again.",
	} as const;
	for (const [code, copy] of Object.entries(cases)) {
		test(`${code} renders its exact copy`, async () => {
			vi.stubGlobal("location", { pathname: "/login", search: `?error=${code}`, href: `http://localhost/login?error=${code}` });
			const replaceState = vi.fn();
			vi.stubGlobal("history", { replaceState });
			const { client } = makeClient();
			const renderer = await renderAsync(<Login client={client} onSuccess={() => {}} />);
			expect(renderer.root.findByProps({ className: "auth-error" }).props.children).toBe(copy);
			expect(loginErrorCopy(code)).toBe(copy);
			expect(replaceState).toHaveBeenCalledWith(null, "", "/login");
		});
	}
	test("login_failed and unknown errors use a generic message without echoing provider details", async () => {
		expect(loginErrorCopy("login_failed")).toBe("Sign-in failed. Try again.");
		expect(loginErrorCopy("provider secret raw error")).toBe("Sign-in failed. Try again.");
	});
});
