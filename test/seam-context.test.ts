/**
 * pi-durable 1.4.0 context-boundary pins (upgrade design D1): extensions
 * receive the contract's structural HandlerContext, while durable commits
 * and snapshots require chord's full Context (telemetry + values). These
 * tests prove the seam upgrades structural literals before they cross into
 * pi-durable, preserves real contexts by identity, and keeps cancellation.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import {
	BACKGROUND_CONTEXT,
	withContextValue,
	createContextKey,
	type Context,
} from "@earendil-works/chord/context";
import type { HandlerContext } from "../src/extension.js";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import { toDurableContext } from "../src/harness/context.js";
import { seededIdentity } from "./helpers/identity.js";
import { askTree, lineTree } from "./helpers/trees.js";

const FIXTURE_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-seam", "index.js"),
).href;

test("toDurableContext upgrades a structural literal to a real context", () => {
	const literal: HandlerContext = { abortSignal: undefined };
	const context = toDurableContext(literal);
	expect(context.telemetry).toBeTypeOf("object");
	expect(context.value).toBeTypeOf("function");
	expect(context.abortSignal).toBeUndefined();
});

test("toDurableContext returns an existing context by identity", () => {
	const key = createContextKey<string>("sigrun.test.seam-context");
	const context = withContextValue(key, "preserved", BACKGROUND_CONTEXT);
	const result = toDurableContext(context);
	expect(result).toBe(context);
	expect(result.value(key)).toBe("preserved");
});

test("toDurableContext carries the structural literal's abort signal", () => {
	const controller = new AbortController();
	const context = toDurableContext({ abortSignal: controller.signal });
	expect(context.abortSignal).toBe(controller.signal);
	controller.abort();
	expect(context.abortSignal?.aborted).toBe(true);
});

test("every context-taking seam method normalizes literals before commit/snapshot", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-seam-context-"));
	let opened: Awaited<ReturnType<typeof openHarness>> | undefined;
	try {
		opened = await openHarness(
			loadConfig({
				SIGRUN_MODEL: "openai/gpt-4o",
				SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
				SIGRUN_AUTH: "none",
				SIGRUN_WORKSPACE_PATH: dir,
			}),
			{
				identity: await seededIdentity(dir),
				env: {},
				extensionSpecifiers: [FIXTURE_SPECIFIER],
			},
		);
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		const host = opened.seamHosts.get("sigrun-fixture-seam");
		expect(host).toBeDefined();
		if (host === undefined) throw new Error("seam host missing");

		const commit = vi.spyOn(opened.harness, "commit");
		const snapshot = vi.spyOn(opened.harness, "snapshot");
		// Extensions satisfy the contract structurally, not by constructing a
		// chord Context. Cast once here to exercise that runtime boundary.
		const literal = { abortSignal: undefined } as unknown as Context;
		const interaction = (callId: string) => ({
			kind: "fixture.ask",
			callId,
			status: "pending" as const,
			createdAt: 1,
			body: askTree(),
		});

		await host.seedInteraction(root.id, interaction("answer-me"), literal);
		await host.seedInteraction(root.id, interaction("settle-me"), literal);
		await expect(host.peekInteraction(root.id, "answer-me", literal)).resolves.toMatchObject({
			status: "pending",
		});
		await expect(
			host.answerInteraction(
				root.id,
				"answer-me",
				{ values: { decision: "allow" } },
				literal,
			),
		).resolves.toBe(true);
		await expect(host.snapshotInteraction(root.id, "answer-me", literal)).resolves.toMatchObject({
			status: "answered",
		});
		await expect(
			host.settleInteraction(root.id, "settle-me", "cancelled", literal),
		).resolves.toBe(true);
		await host.setAmbient(
			root.id,
			{ key: "fixture.panel", place: "status", body: lineTree("ready") },
			literal,
		);
		await host.clearAmbient(root.id, "fixture.panel", literal);

		// Two seeds, answer, settle, set and clear: every durable write got
		// the full context, not the extension's structural literal.
		expect(commit).toHaveBeenCalledTimes(6);
		expect(snapshot).toHaveBeenCalledTimes(2);
		for (const call of [...commit.mock.calls, ...snapshot.mock.calls]) {
			const forwarded = call.at(-1) as Context;
			expect(forwarded).not.toBe(literal);
			expect(forwarded.telemetry).toBeTypeOf("object");
			expect(forwarded.value).toBeTypeOf("function");
		}

		// Normalization must not bypass the accessor's existing abort gate.
		const controller = new AbortController();
		controller.abort(new Error("caller cancelled"));
		await expect(
			host.clearAmbient(root.id, "fixture.panel", {
				abortSignal: controller.signal,
			} as unknown as Context),
		).rejects.toThrow("caller cancelled");
		expect(commit).toHaveBeenCalledTimes(6);
	} finally {
		if (opened !== undefined) {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
		await rm(dir, { recursive: true, force: true });
	}
});
