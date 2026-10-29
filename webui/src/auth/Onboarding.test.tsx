import { act } from "react";
import { describe, expect, test, vi } from "vitest";
import { ApiError, type OnboardingState, type SigrunClient } from "../api";
import { renderAsync } from "../test-utils";
import { Onboarding } from "./Onboarding";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

const STATE: OnboardingState = {
	state: "unclaimed",
	methods: ["token"],
	codeRequired: false,
};

describe("Onboarding error copy", () => {
	test("a 409 username_taken claim error renders friendly copy, not the wire code", async () => {
		const client = {
			claim: vi.fn().mockRejectedValue(
				new ApiError({
					method: "POST",
					path: "/v1/onboarding/claim",
					status: 409,
					error: "username_taken",
				}),
			),
		} as unknown as SigrunClient;
		const renderer = await renderAsync(
			<Onboarding client={client} state={STATE} onClaimed={() => {}} />,
		);
		await act(async () => {
			renderer.root.findByProps({ "data-auth-field": "user" }).props.onChange({
				target: { value: "alice" },
			});
		});
		await act(async () => {
			await renderer.root.findByProps({ className: "auth-submit" }).props.onClick();
		});
		expect(renderer.root.findByProps({ className: "auth-error" }).props.children).toBe(
			"That username is taken. Choose another.",
		);
		expect(client.claim).toHaveBeenCalledOnce();
	});

	test("an invalid_username claim error explains the usable-character rule", async () => {
		const client = {
			claim: vi.fn().mockRejectedValue(
				new ApiError({
					method: "POST",
					path: "/v1/onboarding/claim",
					status: 400,
					error: "invalid_username",
				}),
			),
		} as unknown as SigrunClient;
		const renderer = await renderAsync(
			<Onboarding client={client} state={STATE} onClaimed={() => {}} />,
		);
		await act(async () => {
			renderer.root.findByProps({ "data-auth-field": "user" }).props.onChange({
				target: { value: "alice" },
			});
		});
		await act(async () => {
			await renderer.root.findByProps({ className: "auth-submit" }).props.onClick();
		});
		expect(renderer.root.findByProps({ className: "auth-error" }).props.children).toBe(
			"That name has no usable characters — use at least one letter or digit.",
		);
	});
});
