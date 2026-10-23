/**
 * The contract consumer fixture (W5 Task 1): a realistic extension
 * factory — every contract field populated, host APIs exercised —
 * compiled against the EMITTED `dist/extension.d.ts` through this
 * fixture's tsconfig `paths` mapping. This is the consumer's-eye check:
 * what an extension package's own `tsc` sees when it depends on
 * `@sigrun/sigrun` and imports the types-only subpath.
 *
 * The file is COMPILED, never executed: every import of the contract is
 * `import type` — nothing loads at runtime, exactly the documented
 * posture.
 */

import { defineExtension, section } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createProvider } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai";
import type {
	Access,
	AmbientRecord,
	DirectoryUserWire,
	ExtensionCommandContribution,
	ExtensionLifecyclePayload,
	ExtensionRouteContribution,
	ExtensionWorker,
	InteractionRecord,
	JobSpec,
	ModelEntry,
	NotifierContribution,
	ProviderContribution,
	RunSettledEvent,
	Sharing,
	SigrunExtensionFactory,
	SigrunExtensionResult,
	SigrunHost,
	SlashCommand,
	WebuiBundleContribution,
} from "@sigrun/sigrun/extension";

// ---------------------------------------------------------------------------
// Field-level pins: the shapes are specific, not `unknown` — assignments
// that only compile against the real contract types.
// ---------------------------------------------------------------------------

const sharing: Sharing = { scope: "household", level: "read" };
const sharingLevel: "read" | "write" = sharing.level;

const worker: ExtensionWorker = {
	name: "curator",
	// wakeOn-only: `every` is not a field of the type (ruling 12).
	wakeOn: ["conversationIdle"],
	run: async (context, wake) => {
		const signal: AbortSignal | undefined = context.abortSignal;
		signal?.throwIfAborted();
		if (wake !== undefined) {
			const where: number = wake.conversationId;
			void where;
		}
	},
};

const job: JobSpec = {
	name: "nightly-prune",
	schedule: { cron: "0 3 * * *" },
	action: { kind: "task", task: "prune" },
};

const interaction: InteractionRecord = {
	kind: "gating.confirm",
	callId: "call-1",
	status: "pending",
	createdAt: 0,
	body: { text: "allow this?" },
};

const ambient: AmbientRecord = {
	key: "acme",
	owner: "acme",
	place: "status",
	expires: "never",
	updatedAt: 0,
	body: { line: { text: "ok" } },
};
void ambient;

const user: DirectoryUserWire = {
	user: "alice",
	admin: true,
	createdAt: 0,
	source: "invite",
};
const userName: string = user.user;

const route: ExtensionRouteContribution = {
	method: "POST",
	path: "hook",
	auth: "public",
	handler: async (request, ctx) => {
		const body: string = await request.text();
		void ctx.host;
		void ctx.principal?.user;
		return Response.json({ received: body });
	},
};

const command: ExtensionCommandContribution = {
	name: "hello",
	description: "say hi",
	run: async (ctx) => {
		const id: number = ctx.conversationId;
		void id;
		void ctx.principal;
		void ctx.host;
		return { notice: `hi ${ctx.args}` };
	},
};

const notifier: NotifierContribution = {
	name: "acme-notify",
	notify: async (event, ctx) => {
		const title: string = event.title;
		void title;
		void event.url;
		void ctx.host;
	},
};

// The provider contribution, built the way a real plugin builds one
// (docs/extending.md "Contributing model providers"): a `createProvider`
// result with an empty BASELINE catalog (the purely-dynamic shape — the
// refresh fills it) and a synchronous readiness tracker.
const provider: Provider = createProvider({
	id: "acme",
	name: "Acme",
	auth: {
		apiKey: {
			name: "Acme API key",
			resolve: async () => undefined,
		},
	},
	models: [],
});

const contribution: ProviderContribution = {
	provider,
	defaultModel: { provider: "acme", modelId: "acme-1" },
	readiness: () => ({ status: "ready" }),
};

const bundle: WebuiBundleContribution = { name: "acme-webui", dir: "../webui" };

// A lifecycle payload read: the handler's event is the payload of the
// event the handler names, not a generic bag.
const createdPayload: ExtensionLifecyclePayload["conversationCreated"] = {
	conversationId: 7 as ConversationId,
};
const createdId: number = createdPayload.conversationId;

const onSettled = async (
	event: RunSettledEvent,
	api: Parameters<NonNullable<SigrunExtensionResult["runSettled"]>>[1],
	context: Parameters<NonNullable<SigrunExtensionResult["runSettled"]>>[2],
): Promise<void> => {
	const texts: readonly string[] = event.inputTexts;
	void texts;
	if (event.outcome.status === "answered") {
		const answerId: number = event.outcome.answerEntryId;
		void answerId;
		const entry = await api.entry(event.outcome.answerEntryId, context);
		void entry;
		return;
	}
	const reason: string = event.outcome.reason;
	void reason;
	context.abortSignal?.throwIfAborted();
};

void [sharingLevel, userName, createdId];

// ---------------------------------------------------------------------------
// The factory: a full result, every field, typed by the contract.
// ---------------------------------------------------------------------------

const factory: SigrunExtensionFactory = (host: SigrunHost) => {
	void host.stores.secrets;
	void host.stores.settings;
	void host.stores.paths.cache;

	const result: SigrunExtensionResult = {
		extension: defineExtension({
			name: "@acme/tool",
			sections: [section("acme-note", () => "acme tool loaded")],
		}),
		providers: [contribution],
		webuiBundles: [bundle],
		health: () => "ok",
		runSettled: onSettled,
		conversationCreated: async (event, _api, context) => {
			const id: number = event.conversationId;
			void id;
			context.abortSignal?.throwIfAborted();
			await host.seedInteraction(event.conversationId, interaction, context);
		},
		conversationForked: async (event) => {
			void event.childId;
			void event.parentId;
		},
		conversationArchived: async (event) => {
			void event.archived;
		},
		conversationIdle: async (event) => {
			void event.idleMs;
		},
		harnessShutdown: async () => {},
		userDeleted: async (event) => {
			const from: string = event.user;
			const to: string = event.transferTo;
			void from;
			void to;
		},
		interactionKinds: ["gating.confirm"],
		ambientKinds: ["acme"],
		workers: [worker],
		jobs: [job],
		routes: [route],
		commands: [command],
		notifiers: [notifier],
	};

	// The host APIs the contract declares (the conversation/identity/
	// access surfaces land with their implementation): the SIGNATURES are
	// pinned here so the task that binds them cannot change them quietly.
	// `7 as ConversationId` stands in for an id the host returned — the
	// brand is opaque to an extension, which only passes ids around.
	void (async () => {
		const created: ConversationId = await host.conversations.create({
			owner: "alice",
			sharing: { scope: "private" },
			source: "acme",
		});
		const submitted = await host.conversations.submit(
			created,
			[{ type: "text", text: "hello" }],
			{ user: "alice", whenBusy: "followUp" },
		);
		const submittedId: number = submitted.id;
		void submittedId;
		const listed = await host.conversations.list({ owner: "alice" });
		void listed[0]?.name;
		const meta = await host.conversations.meta(created);
		void meta.name;
		const stop = await host.conversations.watch(created, (view) => {
			const viewId: number = view.conversation.id;
			void viewId;
		});
		await stop();

		const users: readonly DirectoryUserWire[] = await host.users.list();
		void users;
		const found: DirectoryUserWire | undefined = await host.users.get("alice");
		void found;

		const access: Access = await host.access.accessOf(
			{ user: "bob" },
			{ owner: "alice", sharing: { scope: "household", level: "read" } },
		);
		void access;

		const acting: string | undefined = await host.identity.actingUser(created);
		void acting;

		// Gateway C4b: the files/models/commands surfaces.
		const uploaded: { path: string } = await host.conversations.upload(created, {
			name: "a.txt",
			mime: "text/plain",
			bytes: new Uint8Array([104, 105]),
		});
		const uploadedPath: string = uploaded.path;
		void uploadedPath;
		const read: { bytes: Uint8Array; mime?: string } =
			await host.conversations.readFile(created, uploaded.path);
		const readBytes: Uint8Array = read.bytes;
		const readMime: string | undefined = read.mime;
		void readBytes;
		void readMime;

		const models: readonly ModelEntry[] = await host.models.list();
		void models;

		const catalog: readonly SlashCommand[] = await host.commands.list();
		void catalog;
		const runResult: { notice?: string } = await host.commands.run(
			created,
			"hello",
			"bob",
			{ user: "alice" },
		);
		const notice: string | undefined = runResult.notice;
		void notice;
	})();

	return result;
};

export default factory;
