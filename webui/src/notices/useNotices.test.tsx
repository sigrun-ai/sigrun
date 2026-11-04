/**
 * useNotices (notices Task 6): the app's lifted per-user notice list.
 * Loads on mount, refetches when `refetchToken` bumps (App bumps it on
 * notice.changed / reconnect hello / tab visibility), tracks arrivals
 * (posted since the last refetch — the peek feed), and owns the
 * dismiss/dismissAll/run action paths.
 */

import { act, useEffect } from "react";
import type TestRenderer from "react-test-renderer";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { UserNotice } from "@sigrun/shared/notices";
import { renderAsync } from "../test-utils";
import { useNotices, type UseNoticesResult } from "./useNotices";

function notice(fields: Partial<UserNotice> & Pick<UserNotice, "id">): UserNotice {
	return {
		user: "acme-user",
		title: `notice ${fields.id}`,
		owner: "acme-ext",
		at: "2026-11-04T10:00:00.000Z",
		...fields,
	};
}

function makeClient(init?: { notices?: UserNotice[] }) {
	const store = { notices: [...(init?.notices ?? [])] };
	const calls: { method: string; path: string; body: unknown }[] = [];
	const client = {
		listNotices: vi.fn(async () => ({ notices: [...store.notices] })),
		dismissNotice: vi.fn(async (id: string) => {
			calls.push({ method: "POST", path: `/v1/notices/${id}/dismiss`, body: {} });
			store.notices = store.notices.filter((one) => one.id !== id);
		}),
		dismissAllNotices: vi.fn(async () => {
			calls.push({ method: "POST", path: "/v1/notices/dismiss-all", body: {} });
			store.notices = [];
		}),
		runNoticeAction: vi.fn(
			async (
				id: string,
				actionId: string,
				body?: { requestId?: string },
			): Promise<import("@sigrun/shared/notices").NoticeActionResponse> => {
				calls.push({
					method: "POST",
					path: `/v1/notices/${id}/actions/${actionId}`,
					body: body ?? {},
				});
				return { ok: true, message: "did it" };
			},
		),
	};
	return { client, store, calls };
}

function HookHost(props: {
	client: ReturnType<typeof makeClient>["client"];
	refetchToken: number;
	onReady: (result: UseNoticesResult) => void;
}) {
	const result = useNotices(props.client as never, { refetchToken: props.refetchToken });
	useEffect(() => {
		props.onReady(result);
	});
	return null;
}

async function mount(init?: { notices?: UserNotice[] }) {
	const { client, store, calls } = makeClient(init);
	let result: UseNoticesResult | null = null;
	const onReady = (next: UseNoticesResult) => {
		result = next;
	};
	let renderer: TestRenderer.ReactTestRenderer;
	await act(async () => {
		renderer = await renderAsync(
			<HookHost client={client} refetchToken={0} onReady={onReady} />,
		);
	});
	const get = (): UseNoticesResult => {
		if (result === null) throw new Error("hook never rendered");
		return result;
	};
	const rerender = async (token: number) => {
		await act(async () => {
			(renderer as TestRenderer.ReactTestRenderer).update(
				<HookHost client={client} refetchToken={token} onReady={onReady} />,
			);
		});
	};
	return { client, store, calls, get, rerender };
}

describe("useNotices", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	test("loads on mount and refetches when refetchToken bumps", async () => {
		const { client, get, rerender } = await mount({
			notices: [notice({ id: "n-1" })],
		});
		expect(get().notices.map((one) => one.id)).toEqual(["n-1"]);
		expect(client.listNotices).toHaveBeenCalledTimes(1);
		await rerender(1);
		expect(client.listNotices).toHaveBeenCalledTimes(2);
		// A rerender WITHOUT a bump refetches nothing.
		await rerender(1);
		expect(client.listNotices).toHaveBeenCalledTimes(2);
	});

	test("dismiss posts the dismiss route and clears the notice via refetch", async () => {
		const { client, get } = await mount({
			notices: [notice({ id: "n-1" }), notice({ id: "n-2" })],
		});
		await act(async () => {
			await get().dismiss("n-1");
		});
		expect(client.dismissNotice).toHaveBeenCalledWith("n-1");
		expect(get().notices.map((one) => one.id)).toEqual(["n-2"]);
	});

	test("dismissAll posts the dismiss-all route and clears the list", async () => {
		const { client, get } = await mount({
			notices: [notice({ id: "n-1" }), notice({ id: "n-2" })],
		});
		await act(async () => {
			await get().dismissAll();
		});
		expect(client.dismissAllNotices).toHaveBeenCalledTimes(1);
		expect(get().notices).toEqual([]);
	});

	test("navigate action routes onNavigate then dismisses", async () => {
		const { client, get } = await mount({
			notices: [notice({ id: "n-1", actions: [
				{ id: "go", label: "Open", kind: "navigate", target: { conversation: 7 } },
			] })],
		});
		const navigated: unknown[] = [];
		await act(async () => {
			await get().run(
				get().notices[0] as UserNotice,
				{ id: "go", label: "Open", kind: "navigate", target: { conversation: 7 } },
				(target) => navigated.push(target),
			);
		});
		expect(navigated).toEqual([{ conversation: 7 }]);
		expect(client.dismissNotice).toHaveBeenCalledWith("n-1");
		expect(client.runNoticeAction).not.toHaveBeenCalled();
	});

	test("open uses noopener window.open then dismisses", async () => {
		const opened: { url: string; target: string; features: string }[] = [];
		vi.stubGlobal("window", {
			...globalThis.window,
			open: (url: string, target: string, features: string) => {
				opened.push({ url, target, features });
				return null;
			},
		});
		const { client, get } = await mount({
			notices: [notice({ id: "n-1", actions: [
				{ id: "go", label: "Docs", kind: "open", url: "https://docs.example.invalid/" },
			] })],
		});
		await act(async () => {
			await get().run(
				get().notices[0] as UserNotice,
				{ id: "go", label: "Docs", kind: "open", url: "https://docs.example.invalid/" },
				() => {},
			);
		});
		expect(opened).toEqual([
			{ url: "https://docs.example.invalid/", target: "_blank", features: "noopener,noreferrer" },
		]);
		expect(client.dismissNotice).toHaveBeenCalledWith("n-1");
		vi.unstubAllGlobals();
	});

	test("extension action ok shows the result message and clears via refetch", async () => {
		const { client, store, get } = await mount({
			notices: [notice({ id: "n-1", actions: [
				{ id: "undo", label: "Undo", kind: "extension", name: "undo-learn" },
			] })],
		});
		// The server's ok path removes the notice (keep absent) — the
		// refetch after the POST sees it gone.
		client.runNoticeAction.mockImplementation(async () => {
			store.notices = store.notices.filter((one) => one.id !== "n-1");
			return { ok: true as const, message: "learn undone" };
		});
		let outcome: unknown;
		await act(async () => {
			outcome = await get().run(
				get().notices[0] as UserNotice,
				{ id: "undo", label: "Undo", kind: "extension", name: "undo-learn" },
				() => {},
			);
		});
		expect(client.runNoticeAction).toHaveBeenCalledWith("n-1", "undo");
		expect(get().notices).toEqual([]);
		expect(outcome).toMatchObject({ ok: true, message: "learn undone" });
	});

	test("extension action failure keeps the notice and reports the error", async () => {
		const { client, get } = await mount({
			notices: [notice({ id: "n-1" })],
		});
		client.runNoticeAction.mockResolvedValue({
			ok: false as const,
			error: { message: "handler exploded" },
		});
		let outcome: unknown;
		await act(async () => {
			outcome = await get().run(
				get().notices[0] as UserNotice,
				{ id: "undo", label: "Undo", kind: "extension", name: "undo-learn" },
				() => {},
			);
		});
		expect(get().notices.map((one) => one.id)).toEqual(["n-1"]);
		expect(outcome).toMatchObject({ ok: false, error: { message: "handler exploded" } });
	});

	test("a returned navigate target routes onNavigate", async () => {
		const { client, get } = await mount({
			notices: [notice({ id: "n-1" })],
		});
		client.runNoticeAction.mockResolvedValue({
			ok: true as const,
			navigate: { job: "nightly-digest" },
		});
		const navigated: unknown[] = [];
		await act(async () => {
			await get().run(
				get().notices[0] as UserNotice,
				{ id: "run", label: "Run", kind: "extension", name: "retry" },
				(target) => navigated.push(target),
			);
		});
		expect(navigated).toEqual([{ job: "nightly-digest" }]);
	});

	test("arrivals carries notices newly posted since the last refetch", async () => {
		const { store, get, rerender } = await mount({ notices: [notice({ id: "n-1" })] });
		expect(get().arrivals).toEqual([]);
		store.notices.unshift(notice({ id: "n-2" }));
		await rerender(1);
		expect(get().arrivals.map((one) => one.id)).toEqual(["n-2"]);
		store.notices.unshift(notice({ id: "n-3" }));
		await rerender(2);
		expect(get().arrivals.map((one) => one.id)).toEqual(["n-3"]);
	});
});
