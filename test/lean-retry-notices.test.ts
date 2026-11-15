/**
 * Attachments workstream Task 6 (lean-retry notice): when a restart left a
 * conversation's reply retried WITHOUT extension request hooks (Task 5's
 * boot-time `OpenedHarness.leanRetries`), `createServer` posts the deferred
 * per-conversation notice once the notices service exists.
 *
 * Unit level: `noticeLeanRetries` over a REAL opened harness (real
 * `SessionMetaDoc` snapshots, real user directory) with the notices post and
 * log injected. Server level: a full restart reproduction — phase A submits
 * into a conversation held mid-generation by a manual gate, closes WITHOUT
 * settling, plants the inflight marker; phase B boots and runs
 * `noticeLeanRetries` exactly the way `createServer` does, and the seeded
 * directory's users observe the real notices service.
 *
 * Fixtures own their literals: provider `faux`, extension `ext-faux`,
 * users `tester` (primary admin) and `alice`, request id `req-unit-restart`.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { UserNoticeInput } from "@sigrun/shared/notices";
import type { IdentityStores } from "../src/harness/identity/index.js";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { noticeLeanRetries } from "../src/server/lean-retry-notices.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity, unclaimedIdentity } from "./helpers/identity.js";

interface PostCall {
	readonly slug: string;
	readonly input: UserNoticeInput;
}

/** An injected notices post: records the calls, optionally throws on the first. */
function recordingPosts(options?: { readonly failFirst?: boolean }): {
	readonly posts: PostCall[];
	readonly post: (slug: string, input: unknown) => Promise<{ id: string }>;
} {
	const posts: PostCall[] = [];
	return {
		posts,
		post: async (slug, input) => {
			posts.push({ slug, input: input as UserNoticeInput });
			if (options?.failFirst === true && posts.length === 1) {
				throw new Error("store: synthetic disk failure");
			}
			return { id: `notice-${posts.length}` };
		},
	};
}

/** A manual gate the faux provider holds the first generation open on. */
function makeGate(): { readonly promise: Promise<void>; release(): void } {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

interface Rig {
	readonly dir: string;
	readonly opened: OpenedHarness;
	close(): Promise<void>;
}

const rigs: Array<() => Promise<void>> = [];
afterEach(async () => {
	// LIFO: a boot's close runs before any workspace removal registered
	// ahead of it; the phase-A test's manual close stays manual.
	for (const teardown of rigs.splice(0).reverse()) await teardown();
});

/**
 * Boot a hermetic harness (faux provider, tmp workspace). `gate` holds the
 * first generation open until released. Identity is seeded BEFORE boot (a
 * second directory user needs the boot admission helper), so `users` here
 * are raw store writes, never post-boot. Registers LIFO teardown: close
 * before workspace removal, and the boot refresh awaited before remove.
 */
async function boot(
	dir: string,
	options?: {
		readonly identity?: IdentityStores;
		readonly gate?: { readonly promise: Promise<void> };
	},
): Promise<Rig> {
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([
		options?.gate === undefined
			? fauxAssistantMessage("answer")
			: async () => {
					await options.gate!.promise;
					return fauxAssistantMessage("gated answer");
				},
	]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "token",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_STATE_DIR: join(dir, "state"),
	});
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const opened = await openHarness(config, {
		identity: options?.identity ?? (await seededIdentity(dir)),
		extensions: [contributor],
		env: {},
		settingsDir: dir,
		builtins: false,
	});
	const close = async () => {
		await opened.harness.close(BACKGROUND_CONTEXT);
	};
	// The boot refresh (and any model-store write it lands) must finish
	// before the workspace is removed — it runs concurrently with boot.
	await opened.bootRefresh;
	// LIFO teardown: the harness closes BEFORE its workspace is removed.
	rigs.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
	rigs.push(close);
	return { dir, opened, close };
}

/** Write one conversation's session-meta doc the way the server writers do. */
async function setMeta(
	opened: OpenedHarness,
	id: ConversationId,
	patch: { readonly name?: string; readonly autoName?: string; readonly owner?: string },
): Promise<void> {
	const conversation = await opened.harness.conversation(id, BACKGROUND_CONTEXT);
	expect(conversation).toBeDefined();
	await conversation!.commit(async (tx) => {
		const draft = await tx.doc(SessionMetaDoc, id);
		if (patch.name !== undefined) draft.name = patch.name;
		if (patch.autoName !== undefined) draft.autoName = patch.autoName;
		if (patch.owner !== undefined) draft.owner = patch.owner;
	}, BACKGROUND_CONTEXT);
}

describe("noticeLeanRetries (unit: real harness, injected post/log)", () => {
	test("one lean conversation owned by alice posts one notice to alice", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-lean-notice-"));
		rigs.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
		const identity = await seededIdentity(dir);
		await identity.users.add({ user: "alice", admin: false, source: "cli" });
		const { opened } = await boot(dir, { identity });
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		await setMeta(opened, root.id, { name: "Quarterly cleanup", owner: "alice" });
		const { posts, post } = recordingPosts();
		await noticeLeanRetries({
			opened: { ...opened, leanRetries: [root.id] },
			notices: { post },
		});
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({
			slug: "core",
			input: {
				user: "alice",
				key: `generation.lean-retry.${root.id}`,
				title: "Reply retried without extensions",
				body:
					`The server restarted while preparing a reply in "Quarterly cleanup", so the reply was retried without extension request hooks. ` +
					`Recall, reminders and similar additions were skipped for that reply.`,
			},
		});
	});

	test("an owner absent from the directory falls back to the primary admin", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-lean-notice-"));
		rigs.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
		const { opened } = await boot(dir); // seeded admin "tester" only
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		await setMeta(opened, root.id, { name: "Orphaned", owner: "ghost" });
		const { posts, post } = recordingPosts();
		await noticeLeanRetries({
			opened: { ...opened, leanRetries: [root.id] },
			notices: { post },
		});
		expect(posts).toHaveLength(1);
		expect(posts[0]!.input.user).toBe("tester");
		expect(posts[0]!.input.key).toBe(`generation.lean-retry.${root.id}`);
	});

	test("an empty directory posts nothing and logs one line", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-lean-notice-"));
		rigs.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
		const { opened } = await boot(dir, { identity: await unclaimedIdentity(dir) });
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		await setMeta(opened, root.id, { name: "Unclaimed" });
		const { posts, post } = recordingPosts();
		const logged: string[] = [];
		await noticeLeanRetries({
			opened: { ...opened, leanRetries: [root.id] },
			notices: { post },
			log: (line: string) => void logged.push(line),
		});
		expect(posts).toHaveLength(0);
		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain("lean retry");
		expect(logged[0]).toContain("Unclaimed");
	});

	test("two lean conversations post two notices (autoName then id fallback)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-lean-notice-"));
		rigs.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
		const identity = await seededIdentity(dir);
		await identity.users.add({ user: "alice", admin: false, source: "cli" });
		const { opened } = await boot(dir, { identity });
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		const second = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" } },
			BACKGROUND_CONTEXT,
		);
		// Root: autoName only → display uses it. Second: no name at all →
		// display falls back to "conversation <id>".
		await setMeta(opened, root.id, { autoName: "Auto Summary", owner: "alice" });
		await setMeta(opened, second.id, { owner: "alice" });
		const { posts, post } = recordingPosts();
		await noticeLeanRetries({
			opened: { ...opened, leanRetries: [root.id, second.id] },
			notices: { post },
		});
		expect(posts).toHaveLength(2);
		expect(posts.map((one) => one.input.key).sort()).toEqual(
			[`generation.lean-retry.${root.id}`, `generation.lean-retry.${second.id}`].sort(),
		);
		for (const one of posts) expect(one.input.user).toBe("alice");
		const byKey = new Map(posts.map((one) => [one.input.key, one.input]));
		expect(byKey.get(`generation.lean-retry.${root.id}`)?.body).toContain(
			`in "Auto Summary",`,
		);
		expect(byKey.get(`generation.lean-retry.${second.id}`)?.body).toContain(
			`in "conversation ${second.id}",`,
		);
	});

	test("a post that throws is logged and the next notice is still posted", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-lean-notice-"));
		rigs.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
		const identity = await seededIdentity(dir);
		await identity.users.add({ user: "alice", admin: false, source: "cli" });
		const { opened } = await boot(dir, { identity });
		const root = await opened.harness.root(BACKGROUND_CONTEXT);
		const second = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" } },
			BACKGROUND_CONTEXT,
		);
		await setMeta(opened, root.id, { name: "First", owner: "alice" });
		await setMeta(opened, second.id, { name: "Second", owner: "alice" });
		const { posts, post } = recordingPosts({ failFirst: true });
		const logged: string[] = [];
		await noticeLeanRetries({
			opened: { ...opened, leanRetries: [root.id, second.id] },
			notices: { post },
			log: (line: string) => void logged.push(line),
		});
		// Both were attempted; the failure was logged, then the next posted.
		expect(posts).toHaveLength(2);
		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain("synthetic disk failure");
		expect(posts[1]!.input.key).toBe(`generation.lean-retry.${second.id}`);
	});

	test("no lean retries is a no-op", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-lean-notice-"));
		rigs.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
		const { opened } = await boot(dir);
		const { posts, post } = recordingPosts();
		const logged: string[] = [];
		await noticeLeanRetries({ opened, notices: { post }, log: (line: string) => void logged.push(line) });
		expect(posts).toHaveLength(0);
		expect(logged).toHaveLength(0);
	});
});

describe("lean-retry notice across a real restart (server level)", () => {
	test("createServer posts the notice for a conversation recovered lean", { timeout: 60_000 }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-lean-restart-"));
		rigs.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
		const identity = await seededIdentity(dir);
		await identity.users.add({ user: "alice", admin: false, source: "cli" });
		const gate = makeGate();
		let rootId: ConversationId | undefined;
		// Phase A: a reply sits mid-generation; the host "crashes" (closes
		// without settling), leaving both the inflight marker and the marker
		// file that phase B's recovery pairs with the live pi.generation task.
		const phaseA = await boot(dir, { identity, gate });
		try {
			const root = await phaseA.opened.harness.root(BACKGROUND_CONTEXT);
			rootId = root.id;
			await setMeta(phaseA.opened, rootId, { name: "Restarted reply", owner: "alice" });
			void root
				.submit(
					{ type: "input", content: "hello", requestId: "req-unit-restart" },
					BACKGROUND_CONTEXT,
				)
				.catch(() => {});
			// Wait for the admission to COMMIT its generation task before the
			// simulated crash (condition-based, not a timing beat): the lean
			// recovery pairs the inflight marker with this live task. The gate
			// keeps the run unsettled, so the task stays pending.
			await vi.waitFor(async () => {
				const inspection = await phaseA.opened.harness.inspect(BACKGROUND_CONTEXT);
				expect(
					inspection.tasks.some(
						(one) => one.record.kind === "pi.generation" && one.record.conversationId === rootId,
					),
				).toBe(true);
			});
		} finally {
			// The simulated crash: release the held model call and close
			// IMMEDIATELY, without awaiting the generation. `submit` was
			// fired-and-forgotten, so no caller waits on the settlement.
			gate.release();
			await phaseA.close();
		}
		const markerDir = join(dir, "state", "core", "inflight-requests");
		await mkdir(markerDir, { recursive: true });
		await writeFile(
			join(markerDir, `${rootId!}.json`),
			JSON.stringify({ conversationId: rootId, taskId: 1, at: Date.now() }),
		);
		// Phase B: boot recovers the lean conversation; the deferred notice
		// runs through the SAME entry point createServer uses.
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const phaseB = await boot(dir, { identity: await seededIdentity(dir) });
			expect(phaseB.opened.leanRetries).toEqual([rootId!]);
			const app = await createServer(phaseB.opened, loadConfig({
				SIGRUN_DEFAULT_MODEL: "faux/m",
				SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
				SIGRUN_AUTH: "token",
				SIGRUN_WORKSPACE_PATH: dir,
				SIGRUN_DATA_DIR: join(dir, "data"),
				SIGRUN_STATE_DIR: join(dir, "state"),
			}));
			rigs.push(() => app.close());
			const notices = await app.sigrunContext.notices.listForUser("alice");
			expect(notices).toHaveLength(1);
			expect(notices[0]).toMatchObject({
				owner: "core",
				user: "alice",
				key: `generation.lean-retry.${rootId!}`,
				title: "Reply retried without extensions",
				body: expect.stringContaining('in "Restarted reply",'),
			});
			// The primary admin got no copy — the live declared owner wins.
			expect(await app.sigrunContext.notices.listForUser("tester")).toHaveLength(0);
		} finally {
			logSpy.mockRestore();
		}
	});
});
