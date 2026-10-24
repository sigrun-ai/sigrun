/**
 * AuthGate (core hardening W1 Task 8, spec §5.4/§5.8): the webui's auth
 * shell — boot probes `GET /v1/onboarding`, renders the onboarding screen
 * while unclaimed, the token login screen on a 401, and the App shell
 * once a principal resolves. These tests drive the full flow through a
 * routing stub fetch (the App shell fetches everything through the same
 * client, so a ready gate provably renders the real shell).
 */

import { act } from "react";
import { describe, expect, test } from "vitest";
import {
	createClient,
	type FetchLike,
	type MetaResponse,
	type OnboardingState,
	type WhoamiResponse,
} from "../api";
import { PINNED_SCHEMA_VERSION } from "../schema-version";
import type { EventSourceFactory } from "../stream";
import { renderAsync, StubEventSource, textContent } from "../test-utils";
import { AuthGate } from "./AuthGate";

/** One recorded fetch (input + init), for body/path asserts. */
type Call = { input: string; method?: string; body?: string | Uint8Array };

const META: MetaResponse = {
	version: "0.0.0-test",
		harnessVersion: "1.0.2",
	schemaVersion: PINNED_SCHEMA_VERSION,
	extensions: [],
	health: { backup: "unconfigured", memory: "ok", providers: "ok" },
	auth: { methods: ["token"], claimed: true },
	backup: {},
	capabilities: { backup: false, channels: ["webui"] },
	dev: false,
	supervised: false,
	seam: { interactions: [], ambient: [] },
	collisions: { webui: [], providers: [], commands: [] },
};

const CLAIMED_IDENTITY: WhoamiResponse = {
	user: "alice",
	admin: true,
	service: false,
	method: "token",
};

const UNCLAIMED: OnboardingState = {
	state: "unclaimed",
	methods: ["token"],
	codeRequired: true,
};

/**
 * The routing stub: the auth surface plus the App shell's §5 fetches.
 * `state.routes` is mutable mid-test — flipping `failAll` to a status
 * makes every subsequent §5 call fail with `{error:"unauthenticated"}`
 * (the revoked-mid-session-cookie shape).
 */
function makeHarness(init?: {
	readonly onboarding?: OnboardingState;
	readonly whoamiStatus?: number;
}) {
	const state = {
		onboarding: init?.onboarding ?? UNCLAIMED,
		whoamiStatus: init?.whoamiStatus ?? 200,
		failAll: 0,
	};
	const calls: Call[] = [];
	const respond = (body: unknown, status = 200) =>
		Promise.resolve({
			ok: status >= 200 && status < 300,
			status,
			json: () => Promise.resolve(body),
			text: () => Promise.resolve(String(body)),
		});
	const fetchImpl: FetchLike = (input, init2) => {
		calls.push({ input, method: init2?.method, body: init2?.body });
		if (state.failAll !== 0 && input.startsWith("/v1/")) {
			return respond({ error: "unauthenticated" }, state.failAll);
		}
		if (input === "/v1/onboarding") return respond(state.onboarding);
		if (input === "/v1/auth/whoami") {
			return state.whoamiStatus === 200
				? respond(CLAIMED_IDENTITY)
				: respond({ error: "unauthenticated" }, state.whoamiStatus);
		}
		if (input === "/v1/auth/login") {
			// A successful login establishes the session: the next whoami
			// probe answers 200 (the stateful browser's cookie).
			state.whoamiStatus = 200;
			return respond({ user: "alice" });
		}
		if (input === "/v1/auth/logout") return respond(undefined, 204);
		if (input === "/v1/onboarding/claim") {
			// The claim lands: the server is claimed from here on.
			state.onboarding = { state: "claimed", methods: ["token"], codeRequired: false };
			return respond({
				user: { user: "alice", admin: true, createdAt: 1, source: "cli" },
			});
		}
		if (input === "/v1/meta") return respond(META);
		if (input === "/v1/models") return respond({ models: [] });
		if (input === "/v1/commands") return respond({ commands: [] });
		if (input === "/v1/conversations" && init2?.method === "POST")
			return respond(
				{
					id: 2,
					view: {
						conversation: { id: 2 },
						entries: [],
						docs: {},
						steer: { busy: false, queued: 0 },
					},
				},
				201,
			);
		if (input === "/v1/conversations")
			return respond({
				conversations: [
					{
						id: 1,
						root: true,
						access: "write",
						owner: "alice",
						archived: false,
						pinned: false,
					},
				],
			});
		if (/^\/v1\/conversations\/\d+\/meta$/.test(input))
			return respond({
				pinned: false,
				tagged: [],
				archived: false,
				draft: { text: "", attachments: [] },
				source: "user",
			});
		if (/^\/v1\/conversations\/\d+\/(interactions|ambient)$/.test(input))
			return respond({ interactions: [], ambient: [] });
		if (input.includes("/files")) return respond({ entries: [] });
		throw new Error(`unexpected fetch ${input}`);
	};
	const sources: { url: string; source: StubEventSource }[] = [];
	const createEventSource: EventSourceFactory = (url) => {
		const source = new StubEventSource();
		sources.push({ url, source });
		return source;
	};
	return {
		calls,
		state,
		client: createClient({ fetch: fetchImpl }),
		createEventSource,
		sources,
	};
}

/** Set an auth input's value through React's onChange (the test-env event). */
async function setValue(
	renderer: Awaited<ReturnType<typeof renderAsync>>,
	field: string,
	value: string,
): Promise<void> {
	const input = renderer.root.findByProps({ "data-auth-field": field });
	await act(async () => {
		input.props.onChange({ target: { value } });
	});
}

/** Click the one button whose label text is exactly `label`. */
async function clickButton(
	renderer: Awaited<ReturnType<typeof renderAsync>>,
	label: string,
): Promise<void> {
	const matches = renderer.root
		.findAllByType("button")
		.filter((button) =>
			(button.children ?? []).some(
				(child) => typeof child === "string" && child.trim() === label,
			),
		);
	if (matches.length !== 1) {
		throw new Error(`expected one "${label}" button, found ${matches.length}`);
	}
	await act(async () => {
		await matches[0]!.props.onClick();
	});
}

describe("AuthGate", () => {
	test("an unclaimed server renders the onboarding screen; the claim posts code + identity + issueToken, then the shell renders", async () => {
		const harness = makeHarness();
		const renderer = await renderAsync(
			<AuthGate
				client={harness.client}
				createEventSource={harness.createEventSource}
			/>,
		);
		expect(
			renderer.root.findAllByProps({ "data-auth-screen": "onboarding" }),
		).toHaveLength(1);
		// The App shell never renders behind the onboarding screen.
		expect(
			renderer.root.findAllByProps({ className: "session-list" }),
		).toHaveLength(0);

		await setValue(renderer, "code", "ABCD-EFGH");
		await setValue(renderer, "user", "alice");
		await setValue(renderer, "name", "Alice Doe");
		await setValue(renderer, "email", "alice@example.com");
		await clickButton(renderer, "Set up sigrun");

		const claim = harness.calls.find((call) =>
			call.input.endsWith("/v1/onboarding/claim"),
		);
		expect(claim).toBeDefined();
		expect(JSON.parse(String(claim!.body))).toEqual({
			code: "ABCD-EFGH",
			user: "alice",
			name: "Alice Doe",
			email: "alice@example.com",
			issueToken: true,
			tokenName: "webui",
		});
		// The minted token was DISCARDED (the cookie is the credential):
		// the only post-claim auth call is the whoami re-probe, and the
		// shell rendered under the cookie it proved.
		expect(
			harness.calls.filter((call) => call.input === "/v1/auth/whoami"),
		).toHaveLength(1);
		expect(
			renderer.root.findAllByProps({ className: "session-list" }),
		).toHaveLength(1);
	});

	test("a proxy identity renders the confirm screen and posts an EMPTY claim body", async () => {
		const harness = makeHarness({
			onboarding: {
				state: "unclaimed",
				methods: ["proxy"],
				codeRequired: false,
				proxyIdentity: { user: "bob", name: "Bob Vouched" },
			},
		});
		const renderer = await renderAsync(
			<AuthGate client={harness.client} createEventSource={harness.createEventSource} />,
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("bob");
		expect(text).toContain("Bob Vouched");
		// No code field on a proxy vouch.
		expect(
			renderer.root.findAllByProps({ "data-auth-field": "code" }),
		).toHaveLength(0);

		await clickButton(renderer, "Continue as bob");
		const claim = harness.calls.find((call) =>
			call.input.endsWith("/v1/onboarding/claim"),
		);
		expect(JSON.parse(String(claim!.body))).toEqual({});
		expect(
			renderer.root.findAllByProps({ className: "session-list" }),
		).toHaveLength(1);
	});

	test("a 401 whoami renders the login screen; signing in posts {token} then re-fetches whoami", async () => {
		const harness = makeHarness({
			onboarding: { state: "claimed", methods: ["token"], codeRequired: true },
			whoamiStatus: 401,
		});
		const renderer = await renderAsync(
			<AuthGate client={harness.client} createEventSource={harness.createEventSource} />,
		);
		expect(
			renderer.root.findAllByProps({ "data-auth-screen": "login" }),
		).toHaveLength(1);
		expect(
			renderer.root.findAllByProps({ className: "session-list" }),
		).toHaveLength(0);

		await setValue(renderer, "token", "sig-secret-token");
		await clickButton(renderer, "Sign in");

		const login = harness.calls.find((call) =>
			call.input.endsWith("/v1/auth/login"),
		);
		expect(JSON.parse(String(login!.body))).toEqual({ token: "sig-secret-token" });
		// The re-fetch: whoami ran TWICE (the 401 probe + the post-login
		// re-probe), and the second one's identity feeds the shell.
		expect(
			harness.calls.filter((call) => call.input === "/v1/auth/whoami"),
		).toHaveLength(2);
		expect(
			renderer.root.findAllByProps({ className: "session-list" }),
		).toHaveLength(1);
		// The rail shows the resolved user (the identity feed).
		expect(textContent(renderer.toJSON())).toContain("alice");
	});

	test("a 401 from an in-app call flips the ready gate back to the login screen", async () => {
		const harness = makeHarness({
			onboarding: { state: "claimed", methods: ["token"], codeRequired: true },
		});
		const renderer = await renderAsync(
			<AuthGate client={harness.client} createEventSource={harness.createEventSource} />,
		);
		expect(
			renderer.root.findAllByProps({ className: "session-list" }),
		).toHaveLength(1);

		// Revoke mid-session: every subsequent §5 call 401s. The sidebar's
		// new-conversation button is a real in-app caller.
		harness.state.failAll = 401;
		const newButton = renderer.root.findByProps({ className: "session-new" });
		await act(async () => {
			await newButton.props.onClick();
		});

		expect(
			renderer.root.findAllByProps({ "data-auth-screen": "login" }),
		).toHaveLength(1);
		expect(
			renderer.root.findAllByProps({ className: "session-list" }),
		).toHaveLength(0);
	});
});
