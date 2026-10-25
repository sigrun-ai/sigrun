import { act } from "react";
import { describe, expect, test, vi } from "vitest";
import { ApiError, createClient, type FetchLike } from "../api";
import { renderAsync } from "../test-utils";
import { LoginCode } from "./LoginCode";

describe("LoginCode", () => {
	test("posts the parked key and code, then redirects to the safe local return target", async () => {
		const assign = vi.fn();
		const calls: { input: string; body?: string | Uint8Array }[] = [];
		const fetchImpl: FetchLike = (input, init) => {
			calls.push({ input, body: init?.body });
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve({ returnTo: "/settings?section=accounts" }),
				text: () => Promise.resolve(""),
			});
		};
		const renderer = await renderAsync(
			<LoginCode
				client={createClient({ fetch: fetchImpl })}
				flowKey="parked-key"
				reason="invite"
				navigate={assign}
			/>,
		);
		await act(async () => {
			renderer.root.findByProps({ "data-auth-field": "login-code" }).props.onChange({ target: { value: " INVITE-123 " } });
		});
		await act(async () => {
			await renderer.root.findByProps({ className: "auth-submit" }).props.onClick();
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("/v1/auth/login/code");
		expect(JSON.parse(String(calls[0]?.body))).toEqual({ key: "parked-key", code: "INVITE-123" });
		expect(assign).toHaveBeenCalledWith("/settings?section=accounts");
	});

	test("an invalid code stays on the interstitial and does not redirect or expose server details", async () => {
		const assign = vi.fn();
		const fetchImpl: FetchLike = () => Promise.reject(new ApiError({ method: "POST", path: "/v1/auth/login/code", status: 403, error: "invalid_code" }));
		const renderer = await renderAsync(
			<LoginCode client={createClient({ fetch: fetchImpl })} flowKey="key" reason="setup" navigate={assign} />,
		);
		await act(async () => {
			renderer.root.findByProps({ "data-auth-field": "login-code" }).props.onChange({ target: { value: "wrong" } });
		});
		await act(async () => {
			await renderer.root.findByProps({ className: "auth-submit" }).props.onClick();
		});
		expect(renderer.root.findByProps({ className: "auth-error" }).props.children).toBe("That code didn't work. Check it and try again.");
		expect(assign).not.toHaveBeenCalled();
	});
});
