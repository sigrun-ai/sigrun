/**
 * Task A10 (curator): user deletion removes the per-user curation state.
 *
 * Learned skills and curation state (versions, overlays, the feed,
 * usage counters) live under `<dataDir>/users/<user>/{skills,curation}`.
 * On `DELETE /v1/users/:user?transferTo=` core REMOVES both — never
 * transfers them: a skill distilled from the departing user's
 * conversations can carry their paths, hosts and preferences, and must
 * not load for the recipient (spec §6.2's ruling, memory's shape).
 *
 * The fail-closed half (Review Focus 1): a curator run in flight when
 * its user is deleted must write NOTHING. The stores resolve
 * cache-first (a store set created before the deletion stays
 * resolvable), so the run's late tool call reaches the store's own
 * `userExists` gate (A4) and fails `user removed` — no root recreated,
 * no file written, no feed entry.
 *
 * Hermetic pattern (curation-host.test.ts): faux provider + tmpdir +
 * `openHarness` + `createServer`, driven through `app.inject()` for the
 * admin delete and `opened.curationHost` for the curation surface.
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type {
	ConversationId,
	JsonObject,
} from "@earendil-works/pi-durable";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly dir: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
}, 120_000);

/** The learned-skill body the runs and seeds write. */
const ACME_SKILL = `---\nname: acme-deploy\ndescription: Deploy acme\n---\n# Deploy\n\nDeploy the acme way.\n`;

/** Boot one hermetic CLAIMED server: tester (admin), alice, bob. */
async function bootServer(
	responses: readonly unknown[] = [],
): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-curation-delete-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000, reasoning: true }],
	});
	faux.setResponses([...responses] as never);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "token",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
	});
	// Naming off: the namer would consume the scripted faux responses.
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const identity = await seededIdentity(dir);
	// Alice and bob are the brief's literals: alice is deleted, bob is
	// the transfer recipient.
	for (const user of ["alice", "bob"]) {
		if (identity.users.get(user) === undefined) {
			await identity.users.add({ user, admin: false, source: "cli" });
		}
	}
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		builtins: true,
		env: { SIGRUN_CONFIG_DIR: join(dir, "config") },
		settingsDir: dir,
	});
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, dir };
}

/** Mint one API token for `user` (the admin gate's credential). */
async function mint(opened: OpenedHarness, user: string): Promise<string> {
	const { token } = await opened.identity.tokens.create("test", user);
	return token;
}

/** The admin delete-with-transfer; resolves the status code. */
async function deleteUser(
	app: FastifyInstance,
	token: string,
	user: string,
	transferTo: string,
): Promise<number> {
	const response = await app.inject({
		method: "DELETE",
		url: `/v1/users/${user}?transferTo=${transferTo}`,
		headers: { authorization: `Bearer ${token}` },
	});
	return response.statusCode;
}

/** The internal conversation whose run doc carries one reviewId. */
async function digestConversationOf(
	opened: OpenedHarness,
	reviewId: string,
): Promise<number | undefined> {
	const { CurationRunDoc } = await import("../src/curation/run-doc.js");
	let cursor: Awaited<
		ReturnType<typeof opened.storage.scanConversations>
	>["next"];
	for (;;) {
		const page = await opened.storage.scanConversations(
			{ order: "descending" },
			50,
			cursor,
			BACKGROUND_CONTEXT,
		);
		for (const record of page.items) {
			const run = await opened.harness.snapshot(
				CurationRunDoc,
				record.id,
				BACKGROUND_CONTEXT,
			);
			if (run?.reviewId === reviewId) return record.id as number;
		}
		if (page.next === undefined) return undefined;
		cursor = page.next;
	}
}

/** One tool's results in call order: `{text, isError}` per result. */
async function toolResults(
	opened: OpenedHarness,
	id: number,
	tool: string,
): Promise<{ text: string; isError: boolean }[]> {
	const conversation = await opened.harness.conversation(
		id as ConversationId,
		BACKGROUND_CONTEXT,
	);
	if (conversation === undefined) throw new Error("conversation vanished");
	const page = await conversation.entries(
		{ order: "ascending" },
		100,
		undefined,
		BACKGROUND_CONTEXT,
	);
	const results: { text: string; isError: boolean }[] = [];
	for (const entry of page.items) {
		if (entry.kind !== "pi.tool-result") continue;
		for (const message of entry.model ?? []) {
			if (message.role !== "toolResult" || message.toolName !== tool) continue;
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("");
			results.push({ text, isError: message.isError });
		}
	}
	return results;
}

// ─── the two brief scenarios ───────────────────────────────────────────────

describe("user deletion removes curation state (curator A10)", () => {
	test("deleting alice removes her learned skills and curation state", { timeout: 60_000 }, async () => {
		const { app, opened, dir } = await bootServer();
		const curation = opened.curationHost;
		// Alice's state: one learned skill (skills/ + curation/ state,
		// versions, feed) and one overlay (curation/overlays).
		await curation
			.skills("alice")
			.apply(
				"acme-deploy",
				{ kind: "create", content: ACME_SKILL },
				{ reviewId: "seed-1" },
			);
		const userDir = join(dir, "config", "skills", "acme-release");
		await mkdir(userDir, { recursive: true });
		await writeFile(
			join(userDir, "SKILL.md"),
			"---\nname: acme-release\ndescription: Release acme\n---\n# Release\n\nCut the acme release.\n",
		);
		const upstream = await curation.upstream("alice", {
			root: "user dir",
			skill: "acme-release",
		});
		expect(upstream).toBeDefined();
		await curation
			.overlays("alice")
			.put(
				{ root: "user dir", skill: "acme-release" },
				"Prefer blue/green releases.",
				upstream!.hash,
				{ actor: "curator" },
			);
		// Both roots exist before the delete; bob starts empty.
		expect(
			(await stat(join(dir, "data", "users", "alice", "skills"))).isDirectory(),
		).toBe(true);
		expect(
			(await stat(join(dir, "data", "users", "alice", "curation"))).isDirectory(),
		).toBe(true);
		expect(await curation.skills("bob").list()).toEqual([]);

		const token = await mint(opened, "tester");
		expect(await deleteUser(app, token, "alice", "bob")).toBe(204);

		// Both roots are gone — removed, not transferred.
		await expect(
			stat(join(dir, "data", "users", "alice", "skills")),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			stat(join(dir, "data", "users", "alice", "curation")),
		).rejects.toMatchObject({ code: "ENOENT" });
		// The recipient gained nothing.
		await expect(
			stat(join(dir, "data", "users", "bob", "skills", "acme-deploy")),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(await curation.skills("bob").list()).toEqual([]);
		// The captured-handle property: alice's cached store set refuses
		// every later op through its own gate — "user removed", and the
		// refusal creates nothing (both roots stay absent).
		await expect(curation.skills("alice").list()).rejects.toThrow(
			"user removed",
		);
		await expect(
			stat(join(dir, "data", "users", "alice", "skills")),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			stat(join(dir, "data", "users", "alice", "curation")),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("a curator run for alice in flight when she is deleted writes nothing", { timeout: 60_000 }, async () => {
		// Review Focus 1. The digest run's first model call lists alice's
		// skills (caching her store set); the second model call is HELD
		// until the delete has completed, so its `create` executes for a
		// user whose record — and curation roots — are already gone.
		let modelCallStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			modelCallStarted = resolve;
		});
		let releaseModelCall!: () => void;
		const held = new Promise<void>((resolve) => {
			releaseModelCall = resolve;
		});
		const { app, opened, dir } = await bootServer([
			fauxAssistantMessage(
				[fauxToolCall("skill_manage", { action: "list" } as JsonObject)],
				{ stopReason: "toolUse" },
			),
			async () => {
				modelCallStarted();
				await held;
				return fauxAssistantMessage(
					[
						fauxToolCall(
							"skill_manage",
							{
								action: "create",
								name: "acme-deploy",
								content: ACME_SKILL,
								reason: "late lesson",
							} as JsonObject,
						),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("digest done"),
		]);
		const curation = opened.curationHost;
		const pending = curation.digestRun("alice", {
			instruction: "Digest the week's hints.",
			allow: ["skill_manage"],
			maxToolCalls: 4,
			maxOutputTokens: 8_000,
			deadlineMs: 30_000,
			reviewId: "digest-delete-1",
			input: "Digest the week's hints.",
		});
		// The run's second model call is live: delete alice under it.
		await started;
		const token = await mint(opened, "tester");
		expect(await deleteUser(app, token, "alice", "bob")).toBe(204);
		releaseModelCall();
		const result = await pending;
		// The run itself settles; the late write reported NO change.
		expect(result.status).toBe("completed");
		expect(result.changes).toEqual([]);
		const run = await digestConversationOf(opened, "digest-delete-1");
		expect(run).toBeDefined();
		const results = await toolResults(opened, run!, "skill_manage");
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ isError: false });
		// The late create failed the store's own gate, verbatim.
		expect(results[1]).toMatchObject({ isError: true });
		expect(results[1]!.text).toBe("user removed");
		// Fail closed: neither root came back for the removed user.
		await expect(
			stat(join(dir, "data", "users", "alice", "skills")),
		).rejects.toMatchObject({ code: "ENOENT" });
		await expect(
			stat(join(dir, "data", "users", "alice", "curation")),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});
