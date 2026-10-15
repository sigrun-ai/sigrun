# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: webui/e2e/ship-gate-hard.spec.ts >> item 7: compaction recall >> degenerate recall returns the compacted-out content
- Location: webui/e2e/ship-gate-hard.spec.ts:220:2

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('.entry-assistant').filter({ hasText: 'ZEBRA-COMPACTED-OUT' })
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 15000ms
  - waiting for locator('.entry-assistant').filter({ hasText: 'ZEBRA-COMPACTED-OUT' })

```

```yaml
- banner:
  - text: "sigrun ext: sigrun.memory backup: unconfigured"
  - combobox "accent theme":
    - option "indigo" [selected]
    - option "emerald"
    - option "amber"
  - button "◐ theme"
  - button "settings": ⚙
- main:
  - navigation "conversations":
    - button "New conversation"
    - list:
      - listitem:
        - 'button "Conversation #1"'
        - button "Archive"
  - region "chat transcript"
  - alert: "sigrun api: POST /v1/conversations/1/submissions failed with status 500"
  - textbox "Message…": remember ZEBRA
  - text: Attach
  - combobox:
    - option "m" [selected]
    - option "m2"
  - button "Compact"
  - button "Send"
  - complementary:
    - region "workspace files":
      - heading "Workspace" [level=2]
      - list:
        - listitem:
          - button "sigrun.db"
        - listitem:
          - button "sigrun.db-shm"
        - listitem:
          - button "sigrun.db-wal"
```

# Test source

```ts
  132 | 				callId: "call-deny",
  133 | 				status: "pending",
  134 | 				createdAt: Date.now(),
  135 | 				body: {
  136 | 					text: "warden: allow this load_skill call? (demo2)",
  137 | 					options: [
  138 | 						{ id: "allow", label: "Allow", tone: "ok" },
  139 | 						{ id: "deny", label: "Deny", tone: "danger" },
  140 | 					],
  141 | 				},
  142 | 			},
  143 | 			BACKGROUND_CONTEXT,
  144 | 		);
  145 | 		await page.goto(server.url);
  146 | 		const card = page.locator(".interaction-card").first();
  147 | 		await expect(card).toBeVisible({ timeout: 15_000 });
  148 | 		await expect(card.locator(".interaction-text")).toContainText("load_skill");
  149 | 		// Approve the first.
  150 | 		await card.locator('input[type="radio"]').first().click();
  151 | 		await card.locator(".interaction-submit").click();
  152 | 		// The second gate's card is still pending: deny it.
  153 | 		const card2 = page
  154 | 			.locator(".interaction-card")
  155 | 			.filter({ hasText: "demo2" });
  156 | 		await expect(card2).toBeVisible({ timeout: 15_000 });
  157 | 		await card2.locator('input[type="radio"]').nth(1).click();
  158 | 		await card2.locator(".interaction-submit").click();
  159 | 		// Both answered: the stack drains.
  160 | 		await expect(page.locator(".interaction-card")).toHaveCount(0, {
  161 | 			timeout: 15_000,
  162 | 		});
  163 | 	});
  164 | });
  165 | 
  166 | // ---------------------------------------------------------------------------
  167 | // Item 7: ask about something compacted out of the live window; degenerate
  168 | // recall returns it.
  169 | // ---------------------------------------------------------------------------
  170 | test.describe("item 7: compaction recall", () => {
  171 | 	let server: E2EServer;
  172 | 	test.beforeAll(async () => {
  173 | 		// The forced compaction policy (the mid-compaction battery driver's
  174 | 		// thresholds) so a warm-up turn compacts out of the live window, AND
  175 | 		// the memory extension so memory_recall exists + the recall source is
  176 | 		// bound (the T26a fix). The third turn's model call is a memory_recall
  177 | 		// tool call — the degenerate recall scans the durable transcript and
  178 | 		// returns the compacted-out marker.
  179 | 		// The forced compaction policy: tight enough that turn 2 compacts the
  180 | 		// marker turn out of the live window, but not so tight it eats the tool
  181 | 		// round (keepRecentTokens 1 was dropping the tool round's frames — the
  182 | 		// E2E's compaction actually fired on the third turn, interrupting the
  183 | 		// tool call). A larger keepRecentTokens keeps the current turn's
  184 | 		// messages while compacting the marker turn.
  185 | 		server = await bootE2EServer({
  186 | 			// The memory extension by repo path (the npm name is unresolvable in this
  187 | 			// hermetic boot — publish prep removed the git dep; the repo checkout
  188 | 			// is the dev shape).
  189 | 			extensionSpecifiers: [
  190 | 				new URL("../../../sigrun-ext-memory-markdown/dist/index.js", import.meta.url)
  191 | 					.href,
  192 | 			],
  193 | 			settings: {
  194 | 				compaction: {
  195 | 					reserveTokens: 127_300,
  196 | 					keepRecentTokens: 2000,
  197 | 					backgroundTokens: 400,
  198 | 				},
  199 | 			},
  200 | 			responses: [
  201 | 				fauxAssistantMessage("the marker answer: ZEBRA-COMPACTED-OUT"),
  202 | 				fauxAssistantMessage("a second turn"),
  203 | 				// The third turn: the model asks memory_recall for the compacted
  204 | 				// content. The tool's result carries the recalled marker.
  205 | 				fauxAssistantMessage(
  206 | 					[
  207 | 						{ type: "text", text: "checking memory" },
  208 | 						fauxToolCall("memory_recall", { query: "ZEBRA" }, { id: "call-recall" }),
  209 | 					],
  210 | 					{ stopReason: "toolUse" },
  211 | 				),
  212 | 				fauxAssistantMessage("the recall returned the marker"),
  213 | 			],
  214 | 		});
  215 | 	});
  216 | 	test.afterAll(async () => {
  217 | 		await server.cleanup();
  218 | 	});
  219 | 
  220 | 	test("degenerate recall returns the compacted-out content", async ({
  221 | 		page,
  222 | 	}) => {
  223 | 		await page.goto(server.url);
  224 | 		await expect(page.locator(".composer-input")).toBeEnabled();
  225 | 		// Turn 1: the content that will compact out.
  226 | 		await page.locator(".composer-input").pressSequentially("remember ZEBRA");
  227 | 		await page.locator(".composer-send").click();
  228 | 		await expect(
  229 | 			page
  230 | 				.locator(".entry-assistant")
  231 | 				.filter({ hasText: "ZEBRA-COMPACTED-OUT" }),
> 232 | 		).toBeVisible({ timeout: 15_000 });
      |     ^ Error: expect(locator).toBeVisible() failed
  233 | 		// Turn 2: forces the compaction.
  234 | 		await page.locator(".composer-input").pressSequentially("another turn");
  235 | 		await page.locator(".composer-send").click();
  236 | 		await expect(
  237 | 			page.locator(".entry-assistant").filter({ hasText: "a second turn" }),
  238 | 		).toBeVisible({ timeout: 15_000 });
  239 | 		// Turn 3: the model recalls the compacted-out marker. The memory_recall
  240 | 		// tool call's result (a pi.tool-result entry) must carry the marker —
  241 | 		// proof the degenerate recall read the durable transcript (the T26a
  242 | 		// binding), not the live window.
  243 | 		await page.locator(".composer-input").pressSequentially("what was the marker?");
  244 | 		await page.locator(".composer-send").click();
  245 | 		// The tool card for memory_recall expands to show the recalled content.
  246 | 		const card = page.locator(".tool-card-header").filter({ hasText: "memory_recall" }).first();
  247 | 		await expect(card).toBeVisible({ timeout: 15_000 });
  248 | 		await card.click();
  249 | 		await expect(
  250 | 			page.locator(".tool-card-output").filter({ hasText: "ZEBRA-COMPACTED-OUT" }),
  251 | 		).toBeVisible({ timeout: 15_000 });
  252 | 	});
  253 | });
  254 | 
  255 | // ---------------------------------------------------------------------------
  256 | // Item 10: restart the server mid-conversation; resume and continue.
  257 | // ---------------------------------------------------------------------------
  258 | test.describe("item 10: restart resume", () => {
  259 | 	test("the transcript survives a server restart and a new submit works", async ({
  260 | 		page: initialPage,
  261 | 	}) => {
  262 | 		let server = await bootE2EServer({
  263 | 			responses: [fauxAssistantMessage("pre-restart answer")],
  264 | 		});
  265 | 		try {
  266 | 			await initialPage.goto(server.url);
  267 | 			await expect(initialPage.locator(".composer-input")).toBeEnabled();
  268 | 			await initialPage.locator(".composer-input").fill("before the restart");
  269 | 			await initialPage.locator(".composer-send").click();
  270 | 			await expect(
  271 | 				initialPage
  272 | 					.locator(".entry-assistant")
  273 | 					.filter({ hasText: "pre-restart answer" }),
  274 | 			).toBeVisible({ timeout: 15_000 });
  275 | 
  276 | 			// Restart the server on the same storage; the conversation resumes.
  277 | 			// Close the page FIRST: the browser's open SSE watch stream would
  278 | 			// otherwise hold the old server's Fastify close() open forever
  279 | 			// (the watch stream is long-lived and never drains).
  280 | 			await initialPage.close();
  281 | 
  282 | 			server = await server.restart({
  283 | 				responses: [fauxAssistantMessage("post-restart answer")],
  284 | 			});
  285 | 			// A fresh page on the restarted server (the closed page's SSE stream
  286 | 			// died with the old server).
  287 | 			const page = await initialPage.context().newPage();
  288 | 			await page.goto(server.url);
  289 | 			// The pre-restart turn is still in the transcript.
  290 | 			await expect(
  291 | 				page
  292 | 					.locator(".entry-assistant")
  293 | 					.filter({ hasText: "pre-restart answer" }),
  294 | 			).toBeVisible({ timeout: 15_000 });
  295 | 			// A new submit works post-restart. Type with real keystrokes
  296 | 			// (pressSequentially) — a fill() sets the DOM value without firing
  297 | 			// the controlled input's onChange, leaving the send button disabled.
  298 | 			await expect(page.locator(".composer-input")).toBeEnabled();
  299 | 			await page.locator(".composer-input").pressSequentially("after the restart");
  300 | 			await expect(page.locator(".composer-send")).toBeEnabled();
  301 | 			await page.locator(".composer-send").click();
  302 | 			await expect(
  303 | 				page
  304 | 					.locator(".entry-assistant")
  305 | 					.filter({ hasText: "post-restart answer" }),
  306 | 			).toBeVisible({ timeout: 15_000 });
  307 | 			// Close the fresh page BEFORE cleanup — its open SSE watch stream
  308 | 			// would otherwise hold the restarted server's close() open forever
  309 | 			// (the same drain issue as the restart leg).
  310 | 			await page.close();
  311 | 		} finally {
  312 | 			await server.cleanup();
  313 | 		}
  314 | 	});
  315 | });
  316 | 
```