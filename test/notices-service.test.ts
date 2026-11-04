/**
 * Notices Task 3: the notices service — validation, access checks, owner
 * scoping, the notice.changed feed, action dispatch, and the
 * visibility-based pruning on the user read.
 *
 * Hermetic pattern (curation-internal.test.ts): a real harness + real
 * Fastify app (`createServer`) over a faux provider, tmp dirs, and
 * `app.inject()`; fixtures are `file://`-imported by the same URL the
 * loader used, so the test and the extension see ONE module instance.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import type { Principal } from "../src/extension.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import type { HostEventWire } from "@sigrun/shared/views";
import { visibleToUser } from "../src/server/visibility.js";
import { NoticeStore } from "../src/notices/store.js";
import type { ServerContext } from "../src/server/context.js";
import { seededIdentity } from "./helpers/identity.js";

/** The valid noticeActions fixture (`acme-notes`, handlers ping/hold). */
const NOTES_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-notice-actions", "index.js"),
).href;

/** The fixture module's exports (the invocation record + its reset). */
type FixtureModule = {
	readonly calls: readonly {
		user: string | undefined;
		payload: unknown;
		noticeId: string;
	}[];
	readonly resetCalls: () => void;
};

/** Import the fixture module by the SAME URL the loader imported. */
async function fixtureModule(): Promise<FixtureModule> {
	return (await import(NOTES_SPECIFIER)) as unknown as FixtureModule;
}

/** One hermetic server with alice (admin) and bob in the directory. */
interface TestRig {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly dir: string;
	readonly hubEvents: HostEventWire[];
	readonly close: () => Promise<void>;
}

async function bootRig(options?: {
	readonly extensionSpecifiers?: readonly string[];
}): Promise<TestRig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-notices-service-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		// Token auth: two directory users under the naive method refuse to
		// boot (the multi-user gate); token auth keeps the rig honest.
		SIGRUN_AUTH: "token",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
	});
	const identity = await seededIdentity(dir, "alice");
	if (identity.users.get("bob") === undefined) {
		await identity.users.add({
			user: "bob",
			admin: false,
			source: "cli",
			groups: [{ source: "test", values: ["team"], updatedAt: Date.now() }],
		});
	}
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		env: { SIGRUN_CONFIG_DIR: join(dir, "config") },
		settingsDir: dir,
		builtins: false,
		...(options?.extensionSpecifiers === undefined
			? {}
			: { extensionSpecifiers: options.extensionSpecifiers }),
		expectHostBridge: true,
	});
	const app = await createServer(opened, config);
	const hubEvents: HostEventWire[] = [];
	opened.events.subscribe((event) => {
		hubEvents.push(event);
	});
	return {
		app,
		opened,
		dir,
		hubEvents,
		close: async () => {
			await app.close();
			await opened.harness.close(BACKGROUND_CONTEXT);
			await rm(dir, { recursive: true, force: true });
		},
	};
}

/** An alice-owned conversation, optionally shared. */
async function aliceConversation(
	opened: OpenedHarness,
	sharing?: { scope: "people"; users: string[]; groups?: string[]; level: "read" | "write" },
): Promise<number> {
	const conversation = await opened.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: opened.defaultModel },
			init: async (tx, id) => {
				const meta = await tx.doc(SessionMetaDoc, id);
				meta.owner = "alice";
				if (sharing !== undefined) meta.sharing = sharing;
			},
		},
		BACKGROUND_CONTEXT,
	);
	return conversation.id as number;
}

/** A principal shape for one directory user. */
function principalOf(user: string): Principal {
	return { user, admin: false, service: false, method: "none" };
}

/** The `notice.changed` hub events a rig collected so far. */
function noticeEvents(rig: TestRig): readonly (HostEventWire & { type: "notice.changed" })[] {
	return rig.hubEvents.filter(
		(event): event is HostEventWire & { type: "notice.changed" } =>
			event.type === "notice.changed",
	);
}

test("post as a fixture extension lands in the user's store and publishes posted", async () => {
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	try {
		const host = rig.opened.seamHosts.get("acme-notes");
		expect(host).toBeDefined();
		const posted = await host!.notices.post({
			user: "alice",
			title: "from acme-notes",
		});
		expect(typeof posted.id).toBe("string");

		// The user's own list (the service read) carries it.
		const notices = await rig.app.sigrunContext.notices.listForUser("alice");
		expect(notices.map((notice) => notice.id)).toContain(posted.id);
		expect(notices[0]?.owner).toBe("acme-notes");

		// And the post announced itself on the hub.
		const events = noticeEvents(rig);
		expect(events).toHaveLength(1);
		expect(events[0]?.change).toBe("posted");
		expect(events[0]?.ids).toEqual([posted.id]);
	} finally {
		await rig.close();
	}
});

test("post rejects an unknown user, naming the field", async () => {
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	try {
		const host = rig.opened.seamHosts.get("acme-notes");
		await expect(
			host!.notices.post({ user: "carol", title: "nobody home" }),
		).rejects.toThrow(/^user: /);
	} finally {
		await rig.close();
	}
});

test("post rejects a conversation the user can't see, naming the field", async () => {
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	try {
		const host = rig.opened.seamHosts.get("acme-notes");
		const hidden = await aliceConversation(rig.opened);
		await expect(
			host!.notices.post({
				user: "bob",
				title: "hidden conversation",
				conversationId: hidden,
			}),
		).rejects.toThrow(/^conversationId: /);
		// The control: alice sees her own conversation, so the post lands.
		const posted = await host!.notices.post({
			user: "alice",
			title: "own conversation",
			conversationId: hidden,
		});
		expect(typeof posted.id).toBe("string");
	} finally {
		await rig.close();
	}
});

test("post rejects a navigate target conversation the user can't see, naming the field", async () => {
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	try {
		const host = rig.opened.seamHosts.get("acme-notes");
		const hidden = await aliceConversation(rig.opened);
		await expect(
			host!.notices.post({
				user: "bob",
				title: "bad navigate",
				actions: [
					{
						id: "go",
						label: "Go",
						kind: "navigate",
						target: { conversation: hidden },
					},
				],
			}),
		).rejects.toThrow(/^actions\[0\]\.target: /);
	} finally {
		await rig.close();
	}
});

test("post rejects an undeclared handler, naming the field", async () => {
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	try {
		const host = rig.opened.seamHosts.get("acme-notes");
		await expect(
			host!.notices.post({
				user: "alice",
				title: "undeclared",
				actions: [
					{ id: "go", label: "Go", kind: "extension", name: "nope" },
				],
			}),
		).rejects.toThrow(/^actions\[0\]\.name: /);
	} finally {
		await rig.close();
	}
});

test("clear and listForExtension are owner-scoped", async () => {
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	try {
		const notes = rig.opened.seamHosts.get("acme-notes");
		// A second extension posts into alice's file too (via the service,
		// the shape an "acme-other" extension would take).
		const other = await rig.app.sigrunContext.notices.post("acme-other", {
			user: "alice",
			title: "from acme-other",
		});
		const mine = await notes!.notices.post({ user: "alice", title: "mine" });

		// listForExtension sees only this extension's notices.
		const listed = await notes!.notices.list("alice");
		expect(listed.map((notice) => notice.id)).toEqual([mine.id]);

		// Clearing acme-other's notice by id or key is a no-op (owner-scoped).
		await notes!.notices.clear({ user: "alice", id: other.id });
		await notes!.notices.clear({ user: "alice", key: "never-set" });
		const after = await rig.app.sigrunContext.notices.listForUser("alice");
		expect(after.map((notice) => notice.id).sort()).toEqual(
			[mine.id, other.id].sort(),
		);

		// Clearing my own by key works.
		const keyed = await notes!.notices.post({
			user: "alice",
			title: "keyed",
			key: "slot-1",
		});
		await notes!.notices.clear({ user: "alice", key: "slot-1" });
		const final = await rig.app.sigrunContext.notices.listForUser("alice");
		expect(final.map((notice) => notice.id)).not.toContain(keyed.id);
	} finally {
		await rig.close();
	}
});

test("listForUser drops a notice whose conversation share was revoked, and removes it from the file", async () => {
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	try {
		const host = rig.opened.seamHosts.get("acme-notes");
		const shared = await aliceConversation(rig.opened, {
			scope: "people",
			users: ["bob"],
			level: "read",
		});
		const posted = await host!.notices.post({
			user: "bob",
			title: "shared conversation",
			conversationId: shared,
		});
		// Bob sees it while the share holds.
		let listed = await rig.app.sigrunContext.notices.listForUser("bob");
		expect(listed.map((notice) => notice.id)).toContain(posted.id);

		// Revoke the share: the notice drops off bob's read AND off disk.
		const conversation = await rig.opened.harness.conversation(
			shared as never,
			BACKGROUND_CONTEXT,
		);
		await conversation!.commit(
			async (tx) => {
				const meta = await tx.doc(SessionMetaDoc, shared as never);
				delete meta.sharing;
			},
			BACKGROUND_CONTEXT,
		);
		listed = await rig.app.sigrunContext.notices.listForUser("bob");
		expect(listed.map((notice) => notice.id)).not.toContain(posted.id);
		const file = JSON.parse(
			await readFile(
				join(rig.dir, "data", "users", "bob", "notices.json"),
				"utf8",
			),
		) as { notices: { id: string }[] };
		expect(file.notices.map((notice) => notice.id)).not.toContain(posted.id);
	} finally {
		await rig.close();
	}
});

test("runAction dispatches the declared handler and clears the notice", async () => {
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	try {
		const fixture = await fixtureModule();
		fixture.resetCalls();
		const host = rig.opened.seamHosts.get("acme-notes");
		const posted = await host!.notices.post({
			user: "alice",
			title: "actionable",
			actions: [
				{
					id: "go",
					label: "Go",
					kind: "extension",
					name: "ping",
					payload: { depth: 2 },
				},
			],
		});
		const answer = await rig.app.sigrunContext.notices.runAction(
			principalOf("alice"),
			posted.id,
			"go",
		);
		expect(answer.status).toBe(200);
		expect(answer.body).toEqual({ ok: true, message: "pong" });
		expect(fixture.calls).toHaveLength(1);
		expect(fixture.calls[0]).toEqual({
			user: "alice",
			payload: { depth: 2 },
			noticeId: posted.id,
		});
		// ok:true without keep clears the notice.
		const listed = await rig.app.sigrunContext.notices.listForUser("alice");
		expect(listed.map((notice) => notice.id)).not.toContain(posted.id);
	} finally {
		await rig.close();
	}
});

test("runAction keeps the notice when the handler asks, and maps the failure shapes", async () => {
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	try {
		const host = rig.opened.seamHosts.get("acme-notes");
		const posted = await host!.notices.post({
			user: "alice",
			title: "holdable",
			actions: [
				{ id: "stay", label: "Stay", kind: "extension", name: "hold" },
			],
		});
		const kept = await rig.app.sigrunContext.notices.runAction(
			principalOf("alice"),
			posted.id,
			"stay",
		);
		expect(kept.status).toBe(200);
		const listed = await rig.app.sigrunContext.notices.listForUser("alice");
		expect(listed.map((notice) => notice.id)).toContain(posted.id);

		// 404: an unknown id, and a FOREIGN notice (bob's read of alice's).
		expect(
			(await rig.app.sigrunContext.notices.runAction(principalOf("alice"), "no-such-id", "stay"))
				.status,
		).toBe(404);
		expect(
			(await rig.app.sigrunContext.notices.runAction(principalOf("bob"), posted.id, "stay"))
				.status,
		).toBe(404);
		// 400: an action id the notice lacks.
		expect(
			(await rig.app.sigrunContext.notices.runAction(principalOf("alice"), posted.id, "nope"))
				.status,
		).toBe(400);
		// 409: the owning extension is not loaded. The raw store write
		// bypasses the service's declared-handler gate (a notice from a
		// since-disabled extension IS the §3 shape this status exists for).
		const rawStore = new NoticeStore({
			userArea: join(rig.dir, "data", "users", "alice"),
			user: "alice",
			userCreatedAt: () =>
				rig.opened.identity.users.get("alice")?.createdAt,
			now: () => new Date(),
			onChange: () => {},
			log: () => {},
		});
		const orphanNotice = await rawStore.post("acme-other", {
			user: "alice",
			title: "orphaned action",
			actions: [
				{ id: "go", label: "Go", kind: "extension", name: "ping" },
			],
		});
		const orphan = { id: orphanNotice.id };
		const unavailable = await rig.app.sigrunContext.notices.runAction(
			principalOf("alice"),
			orphan.id,
			"go",
		);
		expect(unavailable.status).toBe(409);
		expect(unavailable.body).toEqual({ error: "notice_action_unavailable" });
	} finally {
		await rig.close();
	}
});

test("removeUser evicts the cached store", async () => {
	const rig = await bootRig({ extensionSpecifiers: [NOTES_SPECIFIER] });
	try {
		const host = rig.opened.seamHosts.get("acme-notes");
		const store = new NoticeStore({
			userArea: join(rig.dir, "data", "users", "bob"),
			user: "bob",
			userCreatedAt: () => rig.opened.identity.users.get("bob")?.createdAt,
			now: () => new Date(),
			onChange: () => {},
			log: () => {},
		});
		const posted = await host!.notices.post({ user: "bob", title: "for bob" });
		// The eviction contract: after removeUser, the service's next read
		// constructs a FRESH store — one whose userCreatedAt lookup has
		// already stopped answering (the directory record is gone). The
		// stamped file reads as void, so bob's notice never comes back.
		expect((await store.list()).map((notice) => notice.id)).toContain(
			posted.id,
		);
		await rig.app.sigrunContext.notices.removeUser("bob");
		await rig.opened.identity.users.remove("bob");
		const listed = await rig.app.sigrunContext.notices.listForUser("bob");
		expect(listed).toEqual([]);
	} finally {
		await rig.close();
	}
});

test("a group share makes the conversation visible to a group member who isn't the request principal", async () => {
	const rig = await bootRig();
	try {
		const ctx = { opened: rig.opened } as ServerContext;
		const shared = (await aliceConversation(rig.opened, {
			scope: "people",
			users: [],
			groups: ["team"],
			level: "read",
		})) as ConversationId;
		// Bob is not the request principal anywhere here — the helper answers
		// for the ARBITRARY directory user named by the call.
		expect(await visibleToUser(ctx, shared, "bob")).toBe(true);
		expect(await visibleToUser(ctx, shared, "alice")).toBe(true);
		expect(await visibleToUser(ctx, shared, "carol")).toBe(false);
	} finally {
		await rig.close();
	}
});
