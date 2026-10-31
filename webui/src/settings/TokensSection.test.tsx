/**
 * Task 5 (0.4.0 follow-up): the API-tokens core cove — the create form
 * (`POST /v1/auth/tokens`), the once-only secret display with its two
 * CLI snippets, the confirm-then-revoke flow, and the session-filtered
 * list (browser sessions never list — they are not API tokens).
 *
 * The CLI snippets read `location.origin` (the webui has no publicUrl —
 * the origin the user reached sigrun through IS the right CLI target;
 * the spec records that ruling). The tui.json alternative is labelled
 * with its location `$SIGRUN_CONFIG_DIR/tui.json` (default
 * `~/.config/sigrun/tui.json`, per `defaultConfigDir` in src/cli.ts).
 */

import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, createClient, type FetchLike } from "../api";
import { renderAsync, textContent } from "../test-utils";
import { TokensSection } from "./TokensSection";

interface Call {
	readonly input: string;
	readonly method?: string;
	readonly body?: string;
}

/** The origin the snippet tests pin (tests own their literals). */
const ORIGIN = "https://sigrun.example.invalid";

/** The once-only secret the fake mint returns. */
const SECRET = "sgr_test_secret_once";

interface HarnessOptions {
	readonly createFails?: boolean;
	readonly revokeFails?: boolean;
}

function makeHarness(options?: HarnessOptions) {
	const calls: Call[] = [];
	const listed = [
		{ id: "t1", name: "laptop", user: "alice", createdAt: 123 },
		{ id: "s1", name: "browser", user: "alice", createdAt: 124, kind: "session" as const },
	];
	const fetchImpl: FetchLike = (input, init) => {
	calls.push({ input, method: init?.method, body: typeof init?.body === "string" ? init.body : undefined });
		if (input === "/v1/auth/tokens" && (init?.method ?? "GET") === "GET") {
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ tokens: listed }),
				text: () => Promise.resolve(""),
			});
		}
		if (input === "/v1/auth/tokens" && init?.method === "POST") {
			if (options?.createFails === true) {
				return Promise.reject(
					new ApiError({
						method: "POST",
						path: "/v1/auth/tokens",
						status: 400,
						error: "invalid_body",
					}),
				);
			}
			return Promise.resolve({
				ok: true,
				status: 201,
				json: () => Promise.resolve({
					token: SECRET,
					record: { id: "t2", name: "ci", user: "alice", createdAt: 125 },
				}),
				text: () => Promise.resolve(""),
			});
		}
		if (input.startsWith("/v1/auth/tokens/")) {
			if (options?.revokeFails === true) {
				return Promise.reject(
					new ApiError({
						method: "DELETE",
						path: input,
						status: 403,
						error: "forbidden",
					}),
				);
			}
			return Promise.resolve({
				ok: true,
				status: 204,
				json: () => Promise.resolve(undefined),
				text: () => Promise.resolve(""),
			});
		}
		return Promise.reject(new Error(`unexpected fetch ${init?.method ?? "GET"} ${input}`));
	};
	return {
		calls,
		client: createClient({ fetch: fetchImpl }),
		listed,
		fetchImpl,
	};
}

/** Stub the origin the snippets read (jsdom/node has no real origin). */
function stubOrigin(): void {
	vi.stubGlobal("location", { origin: ORIGIN });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

async function renderTokens(options?: HarnessOptions) {
	const harness = makeHarness(options);
	stubOrigin();
	const renderer = await renderAsync(<TokensSection client={harness.client} />);
	return { ...harness, renderer };
}

/** Type into the create-name input. */
async function typeName(
	renderer: Awaited<ReturnType<typeof renderTokens>>["renderer"],
	value: string,
): Promise<void> {
	await act(async () => {
		renderer.root
			.findByProps({ className: "token-name-input", type: "text" })
			.props.onChange({ target: { value } });
	});
}

/** Click a button whose visible label is exactly `label`. */
async function clickButton(
	renderer: Awaited<ReturnType<typeof renderTokens>>["renderer"],
	label: string,
): Promise<void> {
	const button = renderer.root
		.findAllByType("button")
		.find(
			(node) =>
				node.props.className?.startsWith?.("token") !== false &&
				(node.children ?? []).some(
					(child) => typeof child === "string" && child.trim() === label,
				),
		);
	if (button === undefined) throw new Error(`no "${label}" button`);
	await act(async () => {
		button.props.onClick();
	});
}

describe("TokensSection", () => {
	test("lists API tokens only — browser sessions (kind: session) never render", async () => {
		const { renderer } = await renderTokens();
		const text = textContent(renderer.toJSON());
		expect(text).toContain("laptop");
		expect(text).not.toContain("browser");
	});

	test("create shows the token ONCE with a copy button and the two CLI snippets (origin = location.origin)", async () => {
		const writeText = vi.fn(() => Promise.resolve());
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		const { renderer, calls } = await renderTokens();
		await typeName(renderer, "ci");
		await clickButton(renderer, "Create token");
		// The POST rode the real route shape.
		const create = calls.find((call) => call.method === "POST");
		expect(create?.input).toBe("/v1/auth/tokens");
		expect(JSON.parse(create?.body ?? "{}")).toEqual({ name: "ci" });
		// The secret shows once, with the env snippet and the tui.json
		// alternative (both against the pinned origin).
		const text = textContent(renderer.toJSON());
		expect(text).toContain(SECRET);
		expect(text).toContain(`SIGRUN_TOKEN=${SECRET} sigrun attach --server ${ORIGIN}`);
		expect(text).toContain(`{"server": "${ORIGIN}", "token": "${SECRET}"}`);
		expect(text).toContain("$SIGRUN_CONFIG_DIR/tui.json");
		expect(text).toContain("~/.config/sigrun/tui.json");
		// The copy button copies the secret itself.
		await clickButton(renderer, "Copy");
		expect(writeText).toHaveBeenCalledWith(SECRET);
	});

	test("after dismissal the token text is gone and re-opening does not show it", async () => {
		const first = await renderTokens();
		await typeName(first.renderer, "ci");
		await clickButton(first.renderer, "Create token");
		expect(textContent(first.renderer.toJSON())).toContain(SECRET);
		// Dismiss: the secret leaves the DOM.
		await clickButton(first.renderer, "Done");
		const dismissed = textContent(first.renderer.toJSON());
		expect(dismissed).not.toContain(SECRET);
		// Re-opening the section (a fresh mount over the SAME client
		// harness) never shows it: the list route never returns secrets.
		const second = await renderAsync(
			<TokensSection client={first.client} />,
		);
		expect(textContent(second.toJSON())).not.toContain(SECRET);
		expect(textContent(second.toJSON())).toContain("laptop");
	});

	test("revoke asks for confirmation, then calls revokeToken and removes the row", async () => {
		const { renderer, calls } = await renderTokens();
		await clickButton(renderer, "Revoke");
		// The first click only asked — no DELETE rode the wire yet.
		expect(calls.some((call) => call.method === "DELETE")).toBe(false);
		expect(textContent(renderer.toJSON())).toContain("Revoke laptop?");
		await clickButton(renderer, "Confirm revoke");
		const revoke = calls.find((call) => call.method === "DELETE");
		expect(revoke?.input).toBe("/v1/auth/tokens/t1");
		// The row is gone.
		expect(textContent(renderer.toJSON())).not.toContain("laptop");
	});

	test("a create failure shows the error and keeps the name input", async () => {
		const { renderer } = await renderTokens({ createFails: true });
		await typeName(renderer, "ci");
		await clickButton(renderer, "Create token");
		expect(renderer.root.findByProps({ role: "alert" }).props.children).toBe("invalid_body");
		const input = renderer.root.findByProps({
			className: "token-name-input",
			type: "text",
		});
		expect(input.props.value).toBe("ci");
		expect(textContent(renderer.toJSON())).toContain("laptop");
	});
});
