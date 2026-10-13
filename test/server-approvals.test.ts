/**
 * Task 9c-ii: approvals surface (list + decide), plus auto-deny wired into the
 * EXISTING abort handler (T9c-i shipped configure + abort; not rebuilt here).
 *
 * CHANGED (publish prep 2.1): core no longer hard-imports the optional
 * approvals package — the approval SEMANTICS are extension-owned and the
 * routes speak the structural capability (src/server/approvals.ts) the
 * loader retains from an extension factory result. The package pin is gone
 * from devDependencies too, so the tests boot the LOCALLY-MIRRORED fixture
 * extension (test/fixtures/fixture-approvals/ — same install name
 * `sigrun.approvals`, same doc kinds, same gate semantics, same capability)
 * through the real extension loader (the `extensionSpecifiers` seam). The
 * routes under test are the REAL routes; only the extension behind the
 * capability is the fixture stand-in for the git-pinned package.
 *
 * Design (LOCKED, brief): the capability lists pending gated calls by joining
 * the conversation view's LiveDoc tool slots (`docs["pi.live"].tools`) to each
 * callId's decision record; a slot pending in Live with no decision doc yet
 * is pending. Decide commits through the capability (first decision wins
 * inside the commit; the route's list pre-check makes unknown ids 404).
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()` (see
 * server-configure.test.ts). The gated `write_file` tool is registered via
 * the harness's registry so the faux model has a write/exec-class call to
 * gate.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import type { FastifyInstance } from "fastify";

/** The fixture approvals extension, imported by specifier (the real loader path). */
const APPROVALS_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-approvals", "index.js"),
).href;

/** One hermetic server: harness + faux provider + Fastify app. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
}

/**
 * Boot a hermetic server. The `write_file` tool (write/exec class → gated by
 * the approvals hook) is always installed. When `options.approvals` is true,
 * the fixture approvals extension is loaded through the real extension loader
 * and its factory-result capability wires the routes; when false/absent, the
 * approvals surface must degrade.
 */
async function bootServer(options?: {
	responses?: FauxResponseStep[];
	approvals?: boolean;
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-appr-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses(options?.responses ?? [fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: {},
		// The extension-loader seam: load the fixture approvals extension when
		// the test wants the live gate, nothing when testing the degraded path.
		...(options?.approvals
			? { extensionSpecifiers: [APPROVALS_SPECIFIER] }
			: {}),
	});
	// Install the gated write tool directly into the registry (write/exec
	// class → the approvals hook gates it).
	opened.registry.install({
		name: "test.write-tool",
		tools: [writeFileTool],
	});
	const app = await createServer(opened, config);
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** A write/exec-class tool the gate holds for approval. */
const writeFileTool = defineTool({
	name: "write_file",
	description: "Write a file (gated: write/exec class).",
	parameters: Type.Object({ path: Type.String(), content: Type.String() }),
	async execute(args) {
		return {
			content: [{ type: "text", text: `wrote ${args.path}` }],
			details: { wrote: args.path },
		};
	},
});

/** GET the approvals list. */
async function listApprovals(app: FastifyInstance, conversationId: number) {
	return app.inject({
		method: "GET",
		url: `/v1/conversations/${conversationId}/approvals`,
	});
}

/** POST an approval decision. */
async function decideApproval(
	app: FastifyInstance,
	conversationId: number,
	approvalId: string,
	decision: "allow" | "deny",
	reason?: string,
) {
	return app.inject({
		method: "POST",
		url: `/v1/conversations/${conversationId}/approvals/${approvalId}`,
		payload: reason === undefined ? { decision } : { decision, reason },
		headers: { "content-type": "application/json" },
	});
}

/** Poll the approvals list until `callId` appears; fail loud on timeout. */
async function waitForApprovalListed(
	app: FastifyInstance,
	conversationId: number,
	callId: string,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const response = await listApprovals(app, conversationId);
		const body = response.json() as {
			approvals: Record<string, unknown>[];
		};
		const found = body.approvals.find((a) => a.callId === callId);
		if (found !== undefined) return found;
		if (Date.now() > deadline) {
			throw new Error(
				`approval ${callId} never listed (last: ${JSON.stringify(body.approvals)})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

// ---------------------------------------------------------------------------
// GET /v1/conversations/:id/approvals — list pending approvals
// ---------------------------------------------------------------------------

describe("GET /v1/conversations/:id/approvals", () => {
	test("returns an empty list when no approvals extension is loaded", async () => {
		const { app, opened } = await bootServer(); // no approvals
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await listApprovals(app, root.id);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ approvals: [] });
	});

	test("returns an empty list when the extension is present but nothing gates", async () => {
		const { app, opened } = await bootServer({ approvals: true });
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await listApprovals(app, root.id);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ approvals: [] });
	});

	test("lists a real gated pending call with status pending", async () => {
		const { app, opened } = await bootServer({
			approvals: true,
			responses: [
				// Turn 1: model emits the gated write call, then (after allow) answers.
				fauxAssistantMessage(
					fauxToolCall(
						"write_file",
						{ path: "/tmp/x", content: "hi" },
						{ id: "call-1" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done after write"),
			],
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const submission = await root.submit(
			{ type: "input", content: [{ type: "text", text: "write the file" }] },
			BACKGROUND_CONTEXT,
		);

		// The gated call appears in the list with status pending, carrying the
		// callId and tool name from the LiveDoc slot. No decision record
		// exists before the first decide — `arguments` (a record field) is
		// absent until then.
		const listed = await waitForApprovalListed(app, root.id, "call-1");
		expect(listed.callId).toBe("call-1");
		expect(listed.toolName).toBe("write_file");
		expect(listed.status).toBe("pending");
		expect(listed.arguments).toBeUndefined();

		// Allow it so the submission settles cleanly (decide via the endpoint).
		await decideApproval(app, root.id, "call-1", "allow");
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");
	});

	test("404s for an unknown conversation id", async () => {
		const { app } = await bootServer({ approvals: true });
		const response = await listApprovals(app, 999999);
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "conversation_not_found" });
	});
});

// ---------------------------------------------------------------------------
// POST /v1/conversations/:id/approvals/:approvalId — decide
// ---------------------------------------------------------------------------

describe("POST /v1/conversations/:id/approvals/:approvalId", () => {
	test("decide allow lets the gated tool run", async () => {
		const { app, opened } = await bootServer({
			approvals: true,
			responses: [
				fauxAssistantMessage(
					fauxToolCall(
						"write_file",
						{ path: "/tmp/ok", content: "yes" },
						{ id: "call-allow" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			],
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const submission = await root.submit(
			{ type: "input", content: [{ type: "text", text: "write" }] },
			BACKGROUND_CONTEXT,
		);
		await waitForApprovalListed(app, root.id, "call-allow");

		const response = await decideApproval(app, root.id, "call-allow", "allow");
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			callId: "call-allow",
			status: "allow",
		});

		const settled = await submission.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");
		// The tool RAN: its result entry carries the write confirmation.
		await root.waitForIdle(BACKGROUND_CONTEXT);
		const page = await root.entries({}, 50, undefined, BACKGROUND_CONTEXT);
		expect(JSON.stringify(page.items)).toContain("wrote /tmp/ok");
	});

	test("decide deny blocks the gated tool with the reason", async () => {
		const { app, opened } = await bootServer({
			approvals: true,
			responses: [
				fauxAssistantMessage(
					fauxToolCall(
						"write_file",
						{ path: "/tmp/no", content: "no" },
						{ id: "call-deny" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("could not write"),
			],
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const submission = await root.submit(
			{ type: "input", content: [{ type: "text", text: "write" }] },
			BACKGROUND_CONTEXT,
		);
		await waitForApprovalListed(app, root.id, "call-deny");

		const response = await decideApproval(
			app,
			root.id,
			"call-deny",
			"deny",
			"not allowed",
		);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			callId: "call-deny",
			status: "deny",
		});

		const settled = await submission.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");
		await root.waitForIdle(BACKGROUND_CONTEXT);
		// The gate blocked the call with the deny reason in the transcript.
		const page = await root.entries({}, 50, undefined, BACKGROUND_CONTEXT);
		expect(JSON.stringify(page.items)).toContain("not allowed");
	});

	test("first decision wins: a second decide 404s (not pending)", async () => {
		const { app, opened } = await bootServer({
			approvals: true,
			responses: [
				fauxAssistantMessage(
					fauxToolCall(
						"write_file",
						{ path: "/tmp/first", content: "1" },
						{ id: "call-first" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			],
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const submission = await root.submit(
			{ type: "input", content: [{ type: "text", text: "write" }] },
			BACKGROUND_CONTEXT,
		);
		await waitForApprovalListed(app, root.id, "call-first");

		const first = await decideApproval(app, root.id, "call-first", "allow");
		expect(first.statusCode).toBe(200);
		// Second decide: the record is no longer pending.
		const second = await decideApproval(app, root.id, "call-first", "deny");
		expect(second.statusCode).toBe(404);
		expect(second.json()).toEqual({ error: "approval_not_pending" });

		const settled = await submission.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");
	});

	test("404s for an unknown approval id", async () => {
		const { app, opened } = await bootServer({ approvals: true });
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await decideApproval(app, root.id, "call-nope", "allow");
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "approval_not_pending" });
	});

	test("503 degraded when no approvals extension is loaded", async () => {
		const { app, opened } = await bootServer(); // no approvals
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await decideApproval(app, root.id, "call-1", "allow");
		expect(response.statusCode).toBe(503);
		expect(response.json()).toEqual({ error: "approvals_unavailable" });
	});

	test("rejects an invalid decision body with 400", async () => {
		const { app, opened } = await bootServer({ approvals: true });
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const bad = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/approvals/call-1`,
			payload: { decision: "maybe" },
			headers: { "content-type": "application/json" },
		});
		expect(bad.statusCode).toBe(400);
	});

	test("404s for an unknown conversation id", async () => {
		const { app } = await bootServer({ approvals: true });
		const response = await decideApproval(app, 999999, "call-1", "allow");
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "conversation_not_found" });
	});
});

// ---------------------------------------------------------------------------
// POST /v1/conversations/:id/abort — auto-deny wiring
// ---------------------------------------------------------------------------

describe("POST /v1/conversations/:id/abort auto-deny", () => {
	test("abort auto-denies the pending approval (reason aborted)", async () => {
		const { app, opened } = await bootServer({
			approvals: true,
			responses: [
				// The model gates and never answers before the abort.
				fauxAssistantMessage(
					fauxToolCall(
						"write_file",
						{ path: "/tmp/abort", content: "x" },
						{ id: "call-abort" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("unreachable"),
			],
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const submission = await root.submit(
			{ type: "input", content: [{ type: "text", text: "write then hang" }] },
			BACKGROUND_CONTEXT,
		);
		await waitForApprovalListed(app, root.id, "call-abort");

		const abortResponse = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/abort`,
		});
		expect(abortResponse.statusCode).toBe(200);
		await submission.wait(BACKGROUND_CONTEXT).catch(() => undefined);
		await root.waitForIdle(BACKGROUND_CONTEXT);

		// The capability's decide observed the auto-deny: the record is denied
		// with reason "aborted" (read through the fixture extension's docs —
		// the same tokens the capability writes, exported for tests).
		const { default: createFixtureApprovals, ApprovalsDoc } = await import(
			APPROVALS_SPECIFIER
		);
		const record = await opened.harness.snapshot(
			ApprovalsDoc,
			root.id,
			"call-abort",
			BACKGROUND_CONTEXT,
		);
		expect(record?.status).toBe("deny");
		expect(record?.reason).toBe("aborted");
		// A later decide is no longer pending.
		const decide = await decideApproval(app, root.id, "call-abort", "allow");
		expect(decide.statusCode).toBe(404);
		// The list no longer shows the call as pending.
		const list = await listApprovals(app, root.id);
		const approvals = (list.json() as { approvals: { callId: string }[] })
			.approvals;
		expect(approvals.find((a) => a.callId === "call-abort")).toBeUndefined();
		// (createFixtureApprovals is imported only to surface the fixture's doc
		// tokens; keep the reference alive so the import is not dropped.)
		expect(typeof createFixtureApprovals).toBe("function");
	});
});