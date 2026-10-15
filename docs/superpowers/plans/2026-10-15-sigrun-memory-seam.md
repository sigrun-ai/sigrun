# Sigrun Memory Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give memory extensions a host-side event surface — `runSettled` (one event per settled run with paired input texts), conversation lifecycle events (created/forked/archived/idle/shutdown), and host-owned idle workers — without owning any memory records, storage, tools, or commands.

**Architecture:** A new `EventBus` module (commit-observation → side-lane fan-out) sits between pi-durable's `Session.subscribeCommits` and the seam host's extension handlers. The loader's factory contract gains validated optional fields (`runSettled`, lifecycle handlers, `workers`); boot wires the bus after `Harness.open`; shutdown drains it between `app.close()` and `harness.close()`. The loader's two-phase host re-key is fixed to mutate-in-place (deepseek review M2) — inbound handlers must be reachable from the host instance the factory captured.

**Tech Stack:** TypeScript (NodeNext), pi-durable 1.2.0 (pinned; `Session.subscribeCommits` is the sole detection mechanism — public API, no internal touching), vitest, Fastify (config knobs only).

**Spec:** `docs/superpowers/specs/2026-10-15-sigrun-memory-seam.md` (with three-model review fixes, commit `6c38fee`; review artifacts in `specs/reviews/2026-10-15-memory-seam-review-*.md`)

## Global Constraints

- pi-durable pinned `1.2.0` exact — no fork, no patch, no deep imports of `dist/harness/*` (`endRun` is not exported; a deep import throws `ERR_PACKAGE_PATH_NOT_EXPORTED` — deepseek review B1, verified).
- The seam owns **events and lifecycle only** — no record schemas, no storage contracts, no recall/injection primitives (user ruling, spec "Design ruling").
- Event fan-out is **global**: every loaded extension receives every event (spec ruling), in extension install order.
- A memory extension must never break admission or answering: handler errors are caught + logged, never fail the run, the settle commit, or the remaining fan-out (spec §1 error isolation; observe-infallibility).
- Delivery is the **bounded side lane**: `subscribeCommits` listeners must not block or call Session APIs (upstream contract, `types.d.ts:826`) — the listener only enqueues.
- Idle = **no input-submission admission AND no live run**; write-type submissions do NOT reset the clock (spec §2 corrected ruling).
- No timers in factory bodies — the host owns all timers (the twill lesson).
- Config knobs join the env > settings-file > default chain with `loadConfig` fail-loud validation: `SIGRUN_HOOK_DEADLINE` (30000ms), `SIGRUN_IDLE_THRESHOLD` (600000ms), `SIGRUN_WORKER_DEADLINE` (600000ms), `SIGRUN_QUEUE_MAX` (1000).
- Tests are hermetic: no network, real `node:sqlite` storage in tmpdirs (the established `bootServer`/`openHarness` pattern).

## Review Focus

1. **A wedged/hung handler must not stall the settle path** — a memory extension whose `runSettled` runs a 10-minute distiller must not delay the next run past `SIGRUN_HOOK_DEADLINE`; expect: run settle completes independently, handler abandoned + logged. → Task 2 (submit-returns-before-handler test), Task 3 (handler-throw test).
2. **Crash-replay must not double-capture a turn** — a run settled, server killed before the event drains, restart: expect `runSettled` fires at most once per submission per process; the durable record never changes; extension dedup is its own cursor (at-least-once per process). → Task 3 (retry-fire-once test).
3. **Steer-merged runs must carry every input** — submit while busy, both texts answered in one run: expect ONE `runSettled` with `inputs`/`inputTexts` length 2 in admission (id) order. → Task 2 (steer-merge test), Task 3 (paired texts test).
4. **An extension patching its own SessionMetaDoc must fire `conversationArchived`** like the server route — boolean flip from any commit fires; doc creation and no-op patches fire nothing. → Task 2 (archive/no-op tests).
5. **A fork of an archived conversation must not fire `conversationArchived(child)`** — inherited `archived: true` via `fork: "current"` with no flip: expect `conversationForked` only. → Task 2 (forked-archived-child test).
6. **Idle must not fire mid-run** — one long run, no further admissions: expect no `conversationIdle` while the run is live. → Task 4 (idle-gate test).

---

### Task 1: The loader host-instance fix (mutate-in-place re-key)

**Files:**
- Modify: `src/harness/seam-host.ts` (`createSeamHost` — add `rekey`)
- Modify: `src/harness/boot.ts` (the `hostContextFactory` closure — re-key in place)
- Modify: `test/fixtures/fixture-seam/index.js` (stash the received host for identity assertion)
- Test: `test/loader.test.ts`

**Interfaces:**
- Consumes: `createSeamHost(identity, kinds, bind)` (seam-host.ts:125, signature unchanged); the loader's two-phase `hostContextFactory` calls (unchanged — the fix lives in boot's closure).
- Produces: `SeamHost.rekey(identity: HostIdentity, kinds: DeclaredKinds): void` — mutates identity + kind sets in place; the object the factory captured IS the final host.

- [ ] **Step 1: Write the failing test**

```ts
// test/loader.test.ts
test("the factory-captured host is the final host (re-key mutates in place)", async () => {
	// The factory captures the host instance it receives; after load, the
	// host boot holds (seamHosts map) must be the SAME instance the fixture
	// factory captured — else inbound handlers registered on the factory's
	// host are unreachable (review M2). The fixture stashes its host on
	// globalThis.__fixtureSeamHost for the identity comparison.
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-rekey-"));
	try {
		(globalThis as any).__fixtureSeamHost = undefined;
		const opened = await openHarness(configWith(dir), {
			env: {},
			extensionSpecifiers: [SEAM_SPECIFIER],
		});
		const captured = (globalThis as any).__fixtureSeamHost;
		const booted = opened.seamHosts.get("sigrun.fixture-seam");
		expect(booted).toBeDefined();
		expect(captured).toBeDefined();
		expect(captured).toBe(booted);
	} finally {
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	}
});
```

Fixture addition (test/fixtures/fixture-seam/index.js, first line inside the factory): `globalThis.__fixtureSeamHost = host;`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/loader.test.ts -t "re-key mutates in place"`
Expected: FAIL — identity mismatch (two different host instances; boot's second factory call created a new one).

- [ ] **Step 3: Implement**

- `seam-host.ts`: add `rekey(identity, kinds)` to the returned object — reassigns the internal `identity` and re-seeds the `interactionKinds`/`ambientKinds` sets (they are closure locals).
- `boot.ts`'s `hostContextFactory` closure becomes:
  ```ts
  hostContextFactory: (extensionName, kinds) => {
      // Second call for an already-created host: re-key IN PLACE. The
      // instance the factory captured (stored under "" pre-resolution)
      // must be the final host (review M2) — never a second instance.
      const host = seamHosts.get(extensionName) ?? seamHosts.get("") ?? createSeamHost({ name: extensionName }, kinds, { bindHarness, harness: harnessOf });
      host.rekey({ name: extensionName }, kinds);
      seamHosts.delete("");
      seamHosts.set(extensionName, host);
      seamKinds.set(extensionName, kinds);
      return host;
  },
  ```

- [ ] **Step 4: Run the full loader + seam suites**

Run: `npx vitest run test/loader.test.ts test/seam.test.ts`
Expected: PASS — the new identity test plus all existing tests (behavior-preserving for outbound-only seams).

- [ ] **Step 5: Commit**

```bash
git add src/harness/seam-host.ts src/harness/boot.ts test/loader.test.ts test/fixtures/fixture-seam/index.js
git commit -m "fix(loader): re-key the seam host in place — the factory-captured instance is the final host"
```

---

### Task 2: The event bus — commit observation + side-lane substrate

**Files:**
- Create: `src/harness/event-bus.ts`
- Test: `test/event-bus.test.ts`

**Interfaces:**
- Consumes: `Harness` (inherits `Session.subscribeCommits(listener) => () => void`, types.d.ts:827 — sigrun's harness IS a Session, types.d.ts:640); settled `SubmissionRecord` (`status:"done"` carries `entry` + `answer`; base carries `conversationId` — types.d.ts:329-364).
- Produces:
  ```ts
  export type SettleGroup = {
      readonly conversationId: ConversationId;
      readonly settled: readonly {
          readonly id: SubmissionId;
          readonly status: "done" | "unanswered";
          readonly entryId: EntryId | undefined;
          readonly answerEntryId: EntryId | undefined;
          readonly reason: string | undefined;
      }[]; // publication order == admission (id) order
  };
  export type LifecycleEvent =
      | { readonly type: "conversationCreated"; readonly conversationId: ConversationId }
      | { readonly type: "conversationForked"; readonly childId: ConversationId; readonly parentId: ConversationId; readonly at: EntryId }
      | { readonly type: "conversationArchived"; readonly conversationId: ConversationId; readonly archived: boolean };
  export class EventBus {
      static open(harness: Harness, options: { queueMax: number; hookDeadlineMs: number }): EventBus;
      onSettled(handler: (event: SettleGroup) => void | Promise<void>): () => void;
      onLifecycle(handler: (event: LifecycleEvent) => void | Promise<void>): () => void;
      /** Drain pending events through the handlers, each deadline-bounded. */
      drain(deadlineMs: number, context: Context): Promise<void>;
      close(): void;
  }
  ```

Detection rules (from the spike + reviews): a `submission` table write with `value.type === "input"` and settled status (`done`/`unanswered`) is a settle; coalesce per publication into one SettleGroup sorted by id. A `conversation` table write with `parent === undefined` → created; with a parent → forked (at = the fork point from the record). A `document.change` on SessionMetaDoc → archived flip vs a per-conversation last-seen map (seeded by `document.create` WITHOUT firing; flips only).

- [ ] **Step 1: Write the failing tests**

```ts
// test/event-bus.test.ts — hermetic boots (openHarness + faux provider on tmpdirs)
describe("settle detection", () => {
	test("a settled run emits one SettleGroup with entry + answer ids");
	test("an unanswered run (provider error) emits status unanswered with reason");
	test("steer-merged runs batch both submissions into one group in admission order");
	test("a retried run emits once (the final attempt)");
	test("a listener throw is caught and logged; other handlers still run");
	test("the commit listener never blocks: submit returns before a slow handler finishes");
	test("queue overflow drops the oldest event and logs (queueMax honored)");
});
describe("lifecycle detection", () => {
	test("conversationCreated fires on create and on fork-child creation");
	test("an archive flip fires conversationArchived(true); un-archive (false); no-op patch fires nothing");
	test("a forked child born archived fires NO conversationArchived event");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/event-bus.test.ts`
Expected: FAIL — `Cannot find module '../src/harness/event-bus.js'`.

- [ ] **Step 3: Implement `EventBus`**

Per the Produces signature. Internals: the `subscribeCommits` listener ONLY filters + enqueues (upstream contract). One drain loop (single side-lane worker): pops events in publication order, per event runs handlers sequentially (install order — Task 3 supplies per-extension registration), each `Promise.race([handler(event), timeout(hookDeadlineMs)])`, rejections caught + `console.error`. Ring buffer bounded by `queueMax`; overflow drops oldest + logs. `drain` resolves when the queue empties or the deadline fires.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/event-bus.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/harness/event-bus.ts test/event-bus.test.ts
git commit -m "feat(harness): event bus — commit-observed settle + lifecycle events, bounded side-lane fan-out"
```

---

### Task 3: `runSettled` — inputTexts resolution + the extension contract

**Files:**
- Modify: `src/harness/event-bus.ts` (text resolution; per-extension handler fan-out)
- Modify: `src/harness/loader.ts` (factory-result field `runSettled` validation)
- Modify: `src/harness/boot.ts` (wire bus → extension handlers)
- Create: `test/fixtures/fixture-memory-events/index.js`, `test/fixtures/fixture-bad-runsettled/index.js`
- Test: `test/memory-seam.test.ts`

**Interfaces:**
- Consumes: `EventBus` (Task 2), `Harness.entry(id)` (public Session read, types.d.ts:884-887 — resolves entries post-commit).
- Produces:
  ```ts
  // loader.ts resolvedFromFactory — one more validated optional field:
  runSettled?: (event: RunSettledEvent, api: MemoryEventApi, context: Context) => void | Promise<void>;
  // Validation: present-but-not-function → quarantine, message exactly:
  // "extension factory returned a runSettled field that is not a function"
  // boot.ts OpenedHarness gains:
  readonly eventBus: EventBus;
  // event-bus.ts:
  export type RunSettledEvent = {
      readonly conversationId: ConversationId;
      readonly inputs: readonly SubmissionId[];
      /** Text blocks of each input's pi.user entry, concatenated; unresolvable/withdrawn → "" at that position. */
      readonly inputTexts: readonly string[];
      readonly outcome:
          | { readonly status: "answered"; readonly answerEntryId: EntryId; readonly answer: AssistantMessage }
          | { readonly status: "unanswered"; readonly reason: string };
  };
  export type MemoryEventApi = Pick<DocumentReader, "entry" | "entries" | "document">; // narrowed: NO taskId, NO memo
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// test/memory-seam.test.ts — fixture extensions record events module-side;
// the test imports the fixture module to read them (the fixture-memory pattern).
test("the fixture extension receives runSettled with paired inputTexts", async () => {
	// boot with fixture-memory-events; submit "remember ZEBRA"; wait idle
	// assert events: [{ inputTexts: ["remember ZEBRA"], outcome.status: "answered",
	//   outcome.answer has text content, inputs.length === 1 }]
});
test("a factory runSettled that is not a function is quarantined with the reason", async () => {
	// fixture-bad-runsettled (runSettled: 42) → outcomes ===
	// [{ name: "sigrun.fixture-bad-runsettled", status: "quarantined",
	//    error: "extension factory returned a runSettled field that is not a function" }]
});
test("inputTexts are position-preserving when a submission's text is unresolvable", async () => {
	// one settled input + one withdrawn queued input (abort mid-run) —
	// expect ["the real text", ""]
});
test("runSettled fires once for a run whose final attempt follows a retry", async () => {
	// faux provider: fail once then answer — exactly one event
});
test("an extension handler throw is caught and logged; the run still settles", async () => {
	// the throwing fixture; the submission is still status done
});
test("handlers receive a narrowed api (no taskId, no memo)", async () => {
	// the fixture records Object.keys(api) — assert no taskId/memo
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/memory-seam.test.ts`
Expected: FAIL — no runSettled delivery; quarantine message missing.

- [ ] **Step 3: Implement**

- Loader: the `runSettled` validation branch (mirror `submit`'s check).
- Bus: resolve texts per settled `done` submission — `harness.entry(record.entry)` → the `pi.user` entry → `model[0].content` text blocks joined (empty string on any failure). Answer: `harness.entry(record.answer)` → AssistantEntry → `model[0]`. The bus gains `registerExtension(name: string, handlers: { runSettled?: Function })` — boot calls it per loaded extension; Task 1's re-key re-registers under the final name.
- Boot: after `Harness.open`, open the bus; register each extension's `runSettled`.
- Fixtures: `fixture-memory-events` (records events + exports them), `fixture-bad-runsettled` (`runSettled: 42`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/memory-seam.test.ts test/event-bus.test.ts test/loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/event-bus.ts src/harness/loader.ts src/harness/boot.ts test/memory-seam.test.ts test/fixtures/fixture-memory-events/ test/fixtures/fixture-bad-runsettled/
git commit -m "feat(harness): runSettled event — paired inputTexts, extension contract + fan-out"
```

---

### Task 4: Lifecycle handlers + `conversationIdle` detection

**Files:**
- Modify: `src/harness/event-bus.ts` (idle sweep state + `harnessShutdown` delivery)
- Modify: `src/harness/loader.ts` (validate the four lifecycle handler fields — same fail-loud pattern)
- Modify: `src/harness/boot.ts` (idle sweep timer; lifecycle registration per extension)
- Modify: `src/index.ts` (shutdown insertion point)
- Modify: `test/fixtures/fixture-memory-events/index.js` (record lifecycle events too)
- Test: `test/memory-seam.test.ts` (extend)

**Interfaces:**
- Consumes: `EventBus.onLifecycle` (Task 2), `SIGRUN_IDLE_THRESHOLD` (Task 6 supplies the config; this task may use a temporary hardcoded default).
- Produces (factory-result optional handlers, each validated like `runSettled` — messages mirror it: `"extension factory returned a conversationIdle field that is not a function"` etc.):
  ```ts
  conversationCreated?: (event: { conversationId: ConversationId }, api: MemoryEventApi, context: Context) => void | Promise<void>;
  conversationForked?: (event: { childId: ConversationId; parentId: ConversationId; at: EntryId }, api: MemoryEventApi, context: Context) => void | Promise<void>;
  conversationArchived?: (event: { conversationId: ConversationId; archived: boolean }, api: MemoryEventApi, context: Context) => void | Promise<void>;
  conversationIdle?: (event: { conversationId: ConversationId; idleMs: number }, api: MemoryEventApi, context: Context) => void | Promise<void>;
  harnessShutdown?: (api: MemoryEventApi, context: Context) => void | Promise<void>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test("the fixture extension receives conversationCreated/Forked and NOT archived for an inherited-archive fork");
test("conversationIdle fires after the threshold of quiet (idleMs >= threshold)");
test("idle does NOT fire while a run is live, even past the threshold"); // Review Focus 6
test("write-type submissions do not reset the idle clock");
test("harnessShutdown fires during shutdown; the handler's commit lands");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/memory-seam.test.ts -t "idle|harnessShutdown|fixture extension receives"`
Expected: FAIL — no idle sweep, no lifecycle delivery.

- [ ] **Step 3: Implement**

- Idle sweep: ONE 1s interval in boot. State: last-input-admission map (Task 2's listener also records `submission` writes with `status: "placed"` + `type: "input"` as admissions AND as live-run starts; the settle events mark run end) + the live-run set. Idle when `now - lastAdmission >= threshold` AND no live run. Fire once per quiet period; re-arm. Never-run conversations (no admission recorded) stay non-idle (no durable anchor — documented).
- `harnessShutdown`: boot exposes `bus.shutdownSequence()` — called from `src/index.ts` `shutdown()` between `app.close()` and `harness.close()`: drain pending settles first (ordering constraint), then deliver `harnessShutdown` (install order, deadline-bounded). Handlers may commit.
- Loader: four validation branches.
- Boot: register each extension's lifecycle handlers on the bus.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/memory-seam.test.ts test/event-bus.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/event-bus.ts src/harness/loader.ts src/harness/boot.ts src/index.ts test/memory-seam.test.ts test/fixtures/fixture-memory-events/
git commit -m "feat(harness): conversation lifecycle events + idle detection + harnessShutdown"
```

---

### Task 5: Idle workers — the curator contract

**Files:**
- Modify: `src/harness/loader.ts` (factory-result `workers` validation)
- Modify: `src/harness/boot.ts` (worker lifecycle: timers, deadline, wake queue, stop ordering)
- Modify: `src/server/index.ts` (`/v1/meta` extension entries gain `workers`)
- Create: `test/fixtures/fixture-workers/index.js`
- Test: `test/memory-workers.test.ts`

**Interfaces:**
- Consumes: lifecycle events (Task 4), `SIGRUN_WORKER_DEADLINE` (Task 6; temp default until then).
- Produces:
  ```ts
  // factory result:
  workers?: readonly {
      readonly name: string;               // unique within the extension, non-empty
      readonly every?: { readonly ms: number };   // > 0
      readonly wakeOn?: readonly ["conversationIdle" | "conversationArchived" | "conversationCreated" | "conversationForked"];
      run(context: Context, wake?: { readonly event: string; readonly conversationId: ConversationId }): Promise<void>;
  }[];
  // /v1/meta extensions[] gains (fields absent until first run):
  workers?: readonly { readonly name: string; readonly lastRunAt?: number; readonly lastError?: string }[];
  ```
  Validation rejections (quarantine, exact messages): `"extension factory returned a worker without a name"`, `"...with a duplicate worker name \"X\""`, `"...whose worker \"X\" has a run field that is not a function"`, `"...whose worker \"X\" has every.ms <= 0"`, `"...whose worker \"X\" has an invalid wakeOn entry"`, `"...declares a worker with neither every nor wakeOn"`.
  Semantics: one run at a time per worker (tick skipped while running); in-flight wakes QUEUED + coalesced (last wins), delivered as the next run's `wake` arg; timed-out run = host abandons (logs; zombie's late writes unguarded — accepted); shutdown: stop timers → await in-flight (30s cap) → then harnessShutdown handlers.

- [ ] **Step 1: Write the failing tests**

```ts
// test/memory-workers.test.ts
test("a worker with every.ms runs periodically (small real timers)");
test("a worker with wakeOn:[conversationIdle] runs on idle, receiving the wake");
test("a wake during an in-flight run is queued and coalesced (one follow-up run, last wake)");
test("one run at a time: a still-running worker skips its next tick (no overlap)");
test("a timed-out run is abandoned and logged; the next tick still runs");
test("validation: no-name / duplicate / run-not-function / every<=0 / bad-wakeOn / no-trigger all quarantine");
test("/v1/meta carries worker names + lastRunAt");
test("shutdown stops workers before harnessShutdown handlers (ordering)");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/memory-workers.test.ts`
Expected: FAIL — factory fields unrecognized.

- [ ] **Step 3: Implement**

- Loader: the validation branches.
- Boot: per-worker state machine (idle/running/pendingWake), host-owned timers, `Promise.race` deadline, shutdown ordering before the Task 4 shutdown delivery.
- `/v1/meta`: the extension entries gain the worker projection (boot owns the registry; the server reads it off `OpenedHarness`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/memory-workers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/harness/loader.ts src/harness/boot.ts src/server/index.ts test/memory-workers.test.ts test/fixtures/fixture-workers/
git commit -m "feat(harness): idle workers — the curator contract (every/wakeOn/deadline/meta)"
```

---

### Task 6: Config knobs

**Files:**
- Modify: `src/config.ts` (4 knobs: parse fns + config field + fail-loud validation)
- Modify: `src/harness/boot.ts` (thread resolved knobs into the bus/workers; delete temporary hardcoded values from Tasks 2-5)
- Test: `test/config.test.ts` (extend)

**Interfaces:**
- Consumes: the env > settings-file > default chain (the `SIGRUN_COMPACTION_*` pattern in config.ts: dedicated parse fns, the offending variable named in the error).
- Produces: `loadConfig` output gains:
  ```ts
  memorySeam: {
      hookDeadlineMs: number;     // SIGRUN_HOOK_DEADLINE, default 30000
      idleThresholdMs: number;    // SIGRUN_IDLE_THRESHOLD, default 600000
      workerDeadlineMs: number;   // SIGRUN_WORKER_DEADLINE, default 600000
      queueMax: number;           // SIGRUN_QUEUE_MAX, default 1000
  };
  ```
  Validation: positive integers; non-numeric/zero/negative → fail loud naming the variable.

- [ ] **Step 1: Write the failing tests**

```ts
// test/config.test.ts — the SIGRUN_COMPACTION_* test pattern:
test("memory-seam knobs default when env + file are silent");      // {30000, 600000, 600000, 1000}
test("memory-seam knobs parse from env");                          // each set → value
test("memory-seam knobs accept settings-file overrides (file wins)");
test("invalid memory-seam knob values fail loud naming the variable"); // "abc", 0, -5
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/config.test.ts -t "memory-seam"`
Expected: FAIL — no `memorySeam` field.

- [ ] **Step 3: Implement** (4 parse fns, the config field, boot threading; remove hardcoded values from earlier tasks)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/harness/boot.ts test/config.test.ts
git commit -m "feat(config): memory-seam knobs — hook/idle/worker deadlines + queue max"
```

---

### Task 7: Port the memory extension onto the seam; retire the submit-binding hack

**Files (extension repo — separate checkout at `~/repos/sigrun-ext-memory-markdown`):**
- Modify: `src/degenerate.ts` (drop the custom `submit` + `pendingInputs` map; capture via a new `onRunSettled` wiring method)
- Modify: `test/memory-degenerate.test.ts` (update the wiring tests)
- Rebuild: `dist/` (committed — the load surface convention)
- Modify (core repo): `test/server-submissions.test.ts` (the "submit binds the memory recall source" test — the fixture keeps its legacy `submit` (it tests the loader contract), but the recall test's assertion path updates to the seam shape), `test/fixtures/fixture-memory/index.js` (header comment notes it mirrors the LEGACY contract)
- Verify (core repo): `webui/e2e/ship-gate-hard.spec.ts` item 7 stays GREEN UNCHANGED

**Interfaces:**
- Consumes: `runSettled` (Tasks 3-4) via the extension factory contract.
- Produces: the memory extension factory result WITHOUT `submit`; observe driven by the host's `runSettled` delivery; `bindRecallSource` deleted (the recall tool reads the durable transcript via entries — the binding existed only because capture needed the live Conversation).

- [ ] **Step 1: Write the failing test** (extension repo)

```ts
// test/memory-degenerate.test.ts
test("createMemory() wiring carries NO submit; capture rides onRunSettled", async () => {
	const wiring = createMemory();
	expect(wiring.submit).toBeUndefined();
	// simulate the host delivering a settled run:
	await wiring.onRunSettled(fakeEvent({ inputTexts: ["hello"], status: "answered" }));
	// the observe ring carries user "hello" + the answer
	expect(wiring.backend.records().map((r) => r.role)).toEqual(["user", "assistant"]);
});
test("recall works without any bound source (reads the durable transcript)");
```

(The wiring shape: `submit(root, submission, context)` → `onRunSettled(event, api, context)`. The observe hook's `afterResponse` is DELETED — the event replaces it. `bindRecallSource` deleted; `recall` reads the transcript directly, which is what it always did.)

- [ ] **Step 2: Run to verify fail**

Run (extension repo): `npx vitest run`
Expected: FAIL — `submit` still defined / `onRunSettled` missing.

- [ ] **Step 3: Implement** (the wiring rewrite; `pendingInputs` deleted; the afterResponse hook deleted — capture = the event)

- [ ] **Step 4: Run to verify pass + rebuild dist**

Run (extension repo): `npx vitest run && npm run build`

- [ ] **Step 5: Core repo: update fixture comment + the server-submissions test; run core suites + e2e**

Run (core repo): `npx vitest run && npm run typecheck && cd webui && npx playwright test e2e/ship-gate-hard.spec.ts -g "item 7"`
Expected: ALL PASS — item 7 unchanged (the extension's behavior contract is identical; only the internal capture path moved).

- [ ] **Step 6: Commit (both repos)**

```bash
cd ~/repos/sigrun-ext-memory-markdown
git add -A && git commit -m "feat!: capture rides runSettled — submit-binding pass-through retired"

cd ~/repos/sigrun
git add test/fixtures/fixture-memory/index.js test/server-submissions.test.ts
git commit -m "test: memory fixture + server-submissions recall test follow the seam shape"
```

---

### Task 8: Whole-branch verification + upstream-issue accuracy

**Files:**
- Modify: `docs/superpowers/specs/2026-10-15-sigrun-memory-seam.md` (only if implementation revealed a correction)

- [ ] **Step 1: Full verification**

Run: `npx vitest run && npm run typecheck && npm run typecheck:webui && npm run build:webui && cd webui && npx playwright test`
Expected: full suite PASS, typechecks clean, e2e 18/18 (item 7 included).

- [ ] **Step 2: Verify the deferred-upstream issue draft** — read the spec's "Deferred upstream" section; confirm line numbers (generation.js:357/:359-362) match the pinned dist and the proposal still describes what sigrun shipped.

- [ ] **Step 3: Commit (if anything changed)**

```bash
git add docs/superpowers/specs/2026-10-15-sigrun-memory-seam.md
git commit -m "docs: memory-seam spec — post-implementation accuracy pass"
```

---

## Self-review (applied during writing)

- **Spec coverage:** §1 runSettled → Tasks 2+3; §2 lifecycle → Tasks 2+4; §3 workers → Task 5; config knobs → Task 6; §4 porting story → Task 7; deferred-upstream accuracy → Task 8; loader host-instance fix (review M2) → Task 1. No gaps.
- **Step scan:** every step names one artifact (test name + assertions, signature, or verification command); no bodies beyond the two the signatures don't determine (the re-key closure in Task 1, the detection rules in Task 2 — both are the spec's own content).
- **Type consistency:** `SettleGroup` (Task 2) is what `RunSettledEvent` (Task 3) builds on; `MemoryEventApi` named identically in Tasks 3+4; `rekey` signature identical in Task 1's Interfaces and seam-host step.
- **Review Focus:** all six items have owning tests (noted per line).
- **Proportion:** 8 tasks, each independently testable, commit-per-task.
