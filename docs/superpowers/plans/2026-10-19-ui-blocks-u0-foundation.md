# U0 — Block-set Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The block set as code: wire types, the data-op applier and text projection (shared, pure), and the schemas, validator, placement rules, limits and typed builders (server-side), published to extensions as `@sigrun/sigrun/blocks`.

**Architecture:**
- `shared/src/blocks/` is pure, zero-dependency TypeScript used by the server, webui and TUI: the types, `applyOps`, `toText`, the icon-name list, and the formats.
- `src/blocks/` holds runtime validation (typebox schemas, `validateTree` with JSON-path errors, the §5.7 placement table, the §4.5 limits) and the builder functions.
- `@sigrun/sigrun/blocks` is an `exports` subpath of the root package. `@sigrun/sigrun` joins `HOST_RUNTIME_MODULES`, so extensions' imports resolve to the server's own copy.

**Tech Stack:** TypeScript (NodeNext), typebox (installed today only transitively; Task 2 adds it to the root `dependencies` at the version already in `package-lock.json`), vitest, fast-check (property tests; add as a root devDependency in Task 1).

**Spec:** `docs/superpowers/specs/2026-10-19-sigrun-ui-blocks-design.md` §3, §4, §5, §6.1, §10, §11.1 (source rules), §14.1–§14.3, §16 (Schemas, Placements, Limits, Data updates, Validation of handler names, Versions).

**Depends on:** core-hardening W0–W5 merged. Assumes sigrun is published: the root `package.json` has no `"private": true` (if it still does when this starts, remove it in Task 4 and say so in the commit).

## Global Constraints

- Block-set version: `v: 1`.
- Limits (§4.5), UTF-8 length of serialized JSON:
  - `chat`: 200 blocks, 256 KiB tree, 256 KiB data;
  - `interaction`, `ambient`: 100 blocks, 64 KiB tree, 64 KiB data;
  - `view`, `panel`, `settings`: 2,000 blocks, 1 MiB tree, 4 MiB data;
  - a collection counts as one block.
- Data URLs: `data:image/(png|jpeg|gif|webp);base64,…`, at most 192 KiB of base64 text. SVG and AVIF rejected everywhere. `http:` image URLs rejected.
- Tones: `neutral`, `accent`, `good`, `warn`, `bad`, `info`. Sizes: `s`, `m`, `l`. `visibleAt`: only `"atLeast:regular"`.
- Formats: `number`, `compact`, `percent`, `currency:<ISO 4217>`, `bytes`, `duration`, `datetime`, `date`, `time`, `relative`.
- Link schemes allowed in `open` and markdown: `https:`, `http:`, `mailto:`.
- Structural props are literals (never `{$: …}`): `type`, `id`, `display`, `groupBy`, `groups`, `reorder`, `select`, `mode`, field `name`s, `columns`, every handler name.
- `shared/` stays zero-dependency: no runtime imports outside `shared/src/`.
- Validation error shape: `{path: string, message: string}`; `path` is a JSON-path-like string such as `root.main[2].collection.reorder`.

## Review Focus

1. **A tree using a block from a newer version** (`v: 2` with an unknown type) — `validateTree(…, {v: 1})` rejects it; `toText` renders `[unsupported block: <type>]` plus the fallback rather than throwing. Owner: Task 2 and Task 3.
2. **A binding where a literal is required** (`display: {$: "/x"}`) — rejected with the prop's path, not accepted and ignored. Owner: Task 2.
3. **Relative bindings outside an item template** (`{$: "./title"}` at the root) — rejected. Owner: Task 2.
4. **`applyOps` on a path that doesn't exist** (`remove /cards/99`) — throws `DataOpError` naming the op index; the caller (U3/U5) treats it as a full-refetch signal. Owner: Task 1.
5. **Unicode in limits** — a 64 KiB tree of multi-byte text counts UTF-8 bytes, not string length. Owner: Task 2.

---

### Task 1: Shared types, `applyOps`, icons, and the purity guard

**Files:**
- Create: `shared/src/blocks/types.ts`, `shared/src/blocks/ops.ts`, `shared/src/blocks/icons.ts`, `shared/src/blocks/lttb.ts`, `shared/src/blocks/transport.ts`, `shared/src/blocks/index.ts`
- Modify: `shared/package.json` (`exports["./blocks"]` → `./dist/blocks/index.js` with types)
- Modify: `test/views-purity.test.ts` (recursive scan; allow `../` imports that resolve inside `shared/src/`)
- Test: `test/blocks-ops.test.ts`, `test/views-purity.test.ts`

**Interfaces:**
- Produces (`@sigrun/shared/blocks`):
  ```ts
  export const BLOCK_SET_VERSION = 1;
  export type Tone = "neutral" | "accent" | "good" | "warn" | "bad" | "info";
  export type Size = "s" | "m" | "l";
  export type Binding = { $: string };
  export type Placement = "view" | "panel" | "settings" | "chat" | "interaction" | "ambient";
  export type Tree = { v: number; root: Block };
  export type Block = PageBlock | StackBlock | ColumnsBlock | GridBlock | SectionBlock | MarkdownBlock | FieldsBlock
    | StatBlock | CalloutBlock | ImageBlock | ChartBlock | MeterBlock | LogBlock | TreeBlock | DiffBlock | DetailsBlock
    | CollectionBlock | FormBlock;               // each exactly as spec §5, with `type` discriminants
  export type Field = TextField | LongtextField | NumberField | ToggleField | ChoiceField | DateField | DatetimeField
    | DaterangeField | SecretField | FileField | ListField;
  export type Action = /* spec §6.1 verbatim */;
  export type DataOp = /* spec §4.3 */; export type DataOps = { ops: DataOp[] };
  export type DataUpdate = { rev: number; ops: DataOp[] };
  export class DataOpError extends Error { readonly opIndex: number }
  export function applyOps(data: JsonObject, ops: readonly DataOp[]): JsonObject;   // pure; returns a new object
  export function resolvePointer(data: JsonValue, pointer: string, item?: JsonValue): JsonValue | undefined; // "./x" against item
  export const ICON_NAMES: readonly string[];  // the 49 names of spec §10.2, exact list below
  export type IconName = (typeof ICON_NAMES)[number];
  export function lttb(points: readonly [number, number][], threshold: number): [number, number][];  // largest-triangle-three-buckets
  export type SurfaceAccess = "none" | "read" | "write";
  export interface SurfaceTransport {                       // implemented by U3 (extension) and U5 (chat); used by U1 and U2
    load(): Promise<{ tree: Tree; data: JsonObject; rev: number; treeRev: number; access: SurfaceAccess }>;
    fetchData(since?: number): Promise<{ rev: number; treeRev: number; data?: JsonObject; ops?: DataOp[] }>;
    act(body: { action: string; payload: JsonValue; actionId: string }): Promise<
      | { ok: true; rev: number; ops?: DataOp[]; navigate?: Action; toast?: string }
      | { ok: false; error: { message: string; field?: string } }>;
    upload(body: { field: string; name: string; bytes: Uint8Array; actionId: string }): ReturnType<SurfaceTransport["act"]>;
    image(src: string, opts: { asPng: boolean }): Promise<Uint8Array>;   // TUI image fetch (U7 routes)
    onChanged(listener: (e: { rev: number; treeRev: number }) => void): () => void;   // fed by surface.changed
  }
  ```
- `ICON_NAMES`: `add, edit, delete, refresh, search, filter, share, copy, link, external, more, check, close, drag, file, folder, calendar, clock, user, users, tag, list, board, chart, image, book, cart, home, bell, lock, key, info, warn, error, success, pending, running, sun, moon, cloud, cloud-sun, cloud-rain, cloud-snow, cloud-lightning, fog, wind, droplets, thermometer, umbrella`.

- [ ] **Step 1: Write failing tests** in `test/blocks-ops.test.ts`:
  - `set /a/b` creates `b`; `remove /items/1` drops index 1; `insert /items/-` appends; `insert /items/0` prepends;
  - `move {from: "/lanes/todo/0", path: "/lanes/done/2"}` moves across arrays; within one array `move /x/3 → /x/0` yields the reordered array;
  - the input object is unchanged (`Object.isFrozen` deep-freeze the input in the test);
  - `remove /items/99` throws `DataOpError` with `opIndex: 0`;
  - property test (fast-check): for random arrays and random valid `move` ops, the result is a permutation of the input (same multiset of ids);
  - `lttb` of 10,000 points to 500 keeps the first and last point and the global max;
  - `resolvePointer({a: [{t: 1}]}, "/a/0/t") === 1`; `resolvePointer(root, "./t", {t: 2}) === 2`; a missing path is `undefined`.
- [ ] **Step 2: Extend the purity test** to scan `shared/src/**/*.ts` recursively and to accept `../` specifiers whose resolved path stays under `shared/src/`; add a case asserting `shared/src/blocks/` files are in the scanned set.
- [ ] **Step 3: Run** `npx vitest run test/blocks-ops.test.ts test/views-purity.test.ts` — expect FAIL (modules missing).
- [ ] **Step 4: Implement** `types.ts` (types only), `ops.ts` (`applyOps` via structural clone of the touched path only, RFC 6901 escaping `~0`/`~1`), `icons.ts`, `index.ts` re-exports; add the `exports` entry.
- [ ] **Step 5: Run** the two tests plus `npm run build:shared && npm run typecheck` — PASS.
- [ ] **Step 6: Commit** `git commit -m "blocks: shared wire types, applyOps, icon names; purity guard scans subdirectories"`.

### Task 2: Schemas, `validateTree`, placements and limits

**Files:**
- Modify: `package.json` (`typebox` in `dependencies`)
- Create: `src/blocks/schema.ts` (typebox schemas per block and field), `src/blocks/validate.ts`, `src/blocks/placements.ts`, `src/blocks/limits.ts`, `src/blocks/images.ts` (source rules only; the proxy is U7)
- Test: `test/blocks-validate.test.ts`, `test/fixtures/blocks/` (one valid sample per block/display/field, reused by the U1/U2 gallery)

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  ```ts
  export interface ValidationError { path: string; message: string }
  export interface ValidateOptions { placement: Placement; handlers?: ReadonlySet<string>; serverV?: number }
  export function validateTree(tree: unknown, opts: ValidateOptions): { ok: true; tree: Tree } | { ok: false; errors: ValidationError[] };
  export function validateData(data: unknown, placement: Placement): { ok: true } | { ok: false; errors: ValidationError[] };
  export const PLACEMENT_RULES: Record<Placement, PlacementRule>;   // spec §5.7 table as data
  export const LIMITS: Record<Placement, { blocks: number; treeBytes: number; dataBytes: number }>;
  export function checkImageSource(src: string): { ok: true; kind: "asset" | "data" | "https" } | { ok: false; message: string };
  ```
- `handlers` is the set of keys in the surface's `actions` map; when given, every handler-name prop must be in it. When omitted (chat), handler names are free labels.

- [ ] **Step 1: Write failing tests:**
  - every fixture in `test/fixtures/blocks/` passes for each placement the §5.7 table allows, and fails with a path for one it doesn't (generate the matrix from `PLACEMENT_RULES` and assert the table's literal cells: e.g. `chart` in `interaction` → error at `root…chart` "not allowed in interaction");
  - interaction forms reject `file` and `daterange` fields; settings forms reject `file`; chat forms reject `secret`;
  - `reorder` without `onMove` → error at `…reorder`; `onMove: "x"` with `handlers: new Set(["y"])` → error "no handler named x";
  - `turn: true` on an action in `view` → error; allowed in `chat`;
  - `display: {$: "/v"}` → error "display must be a literal"; `groups: {$: "/g"}` → error;
  - `{$: "./title"}` outside a collection item template → error;
  - `{v: 2, root: {type: "carousel"}}` with `serverV: 1` → error "unsupported block-set version 2";
  - limits: 201 blocks in `chat` → `surface_too_large` error naming "blocks"; a tree of 65,537 UTF-8 bytes built from 3-byte characters in `interaction` → "treeBytes";
  - `checkImageSource`: `data:image/svg+xml;…` rejected; `data:image/avif;…` rejected; 192 KiB + 1 of base64 rejected; `http://…` rejected; `asset:img/a.png` ok; `https://example.invalid/x.png` ok;
  - an unknown icon name → error at the icon prop;
  - `visibleAt: "atLeast:wide"` → error;
  - `open` with `javascript:alert(1)` → error; `mailto:a@example.invalid` → ok;
  - `status`/`footer` ambient roots with more than one line-level block → error.
- [ ] **Step 2: Run** `npx vitest run test/blocks-validate.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Schemas use typebox with the compiled validator (pass the compiled `Validator`, read errors from `instancePath`; no `additionalProperties: false`). Structural checks the schema can't express (placements, literal-ness, handler names, relative bindings, limits, ambient line rule) run as a second walk that carries the path.
- [ ] **Step 4: Run** the test and `npm run typecheck` — PASS.
- [ ] **Step 5: Commit** `git commit -m "blocks: typebox schemas, validateTree with paths, placement rules, limits, image source rules"`.

### Task 3: `toText`

**Files:**
- Create: `shared/src/blocks/text.ts`, `shared/src/blocks/format.ts`
- Test: `test/blocks-text.test.ts`, `test/__snapshots__/blocks-text.test.ts.snap`

**Interfaces:**
- Produces:
  ```ts
  export interface TextOptions { width: number; locale: string; timeZone?: string }
  export function toText(tree: Tree, data: JsonObject, opts: TextOptions): string;
  export function formatValue(value: JsonValue, format: string | undefined, locale: string, timeZone?: string): string;
  ```

- [ ] **Step 1: Write failing tests:** snapshot every fixture at widths 80 and 160 with locale `en-CA`; plus explicit assertions:
  - a numbered list renders `1. … 2. …`; a checkable list renders `[x]`/`[ ]`;
  - lanes render as one heading per group with its items;
  - a table aligns columns and puts `priority: low` columns last;
  - a chart renders one line per series: `CPU: min 3%, max 97%, latest 41% (240 points)`;
  - an unknown block type renders its `fallback` or `[unsupported block: <type>]`;
  - determinism: `toText(x) === toText(x)` byte-for-byte across two calls and across a `structuredClone` of the input with keys inserted in a different order;
  - `formatValue(1536, "bytes", "en-CA") === "1.5 KB"`; `formatValue(11520000, "duration", …) === "3h 12m"`; `formatValue(2500, "compact", …) === "2.5K"`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** with `Intl` only (no imports outside `shared/src/`). Object keys are visited in schema order, never insertion order.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `git commit -m "blocks: deterministic toText projection and value formats"`.

### Task 4: Builders, `@sigrun/sigrun/blocks`, host-module link

**Files:**
- Create: `src/blocks/builders.ts`, `src/blocks/index.ts` (re-exports builders, types, `validateTree`)
- Modify: `package.json` (`exports["./blocks"]` → `{types: "./dist/blocks/index.d.ts", default: "./dist/blocks/index.js"}`; keep W5's `.` and `./extension`), `tsconfig.build.json` (include `src/blocks`)
- Modify: `src/harness/packages.ts` (`HOST_RUNTIME_MODULES` gains `"@sigrun/sigrun"`), `src/harness/loader.ts` (`EXACT_HOST_MODULES` gains `"@sigrun/sigrun"`: any version difference quarantines, as for pi-durable)
- Modify: `docs/extending.md` (one paragraph: `sigrun` is a `peerDependency: "*"`; import builders from `@sigrun/sigrun/blocks`)
- Modify: `src/config.ts` (`server.dev`, env `SIGRUN_DEV`, strict `true`/`false`, default false), `src/server/routes/meta.ts` (`/v1/meta` reports `dev`); U1's gallery, U3's error bodies and U4 consume it
- Test: `test/blocks-builders.test.ts`, `test/packages.test.ts` (host link), `test/fixtures/fixture-blocks-ext/` (an extension importing `@sigrun/sigrun/blocks`)

**Interfaces:**
- Produces: one builder per block and field, named as the block (`page`, `stack`, `columns`, `grid`, `section`, `markdown`, `fields`, `stat`, `callout`, `image`, `chart`, `meter`, `log`, `tree`, `diff`, `details`, `collection`, `card`, `form`, and fields `text`, `longtext`, `number`, `toggle`, `choice`, `date`, `datetime`, `daterange`, `secret`, `file`, `list`), plus `bind(pointer)` and `tree(root)` (`→ {v: BLOCK_SET_VERSION, root}`). Each takes the block's props object and returns the block. The `tree` block builder is exported as `treeBlock` to avoid the clash.

- [ ] **Step 1: Write failing tests:**
  - `tree(page({title: "T", main: [markdown({text: "x"})]}))` deep-equals the hand-written JSON and passes `validateTree(…, {placement: "view"})`;
  - the §14.1 example (with `groups` as a literal) validates with `handlers: new Set(["move"])`;
  - packages: after boot, `<packagesDir>/node_modules/sigrun` is a symlink to the running package root; `fixture-blocks-ext`'s factory imports `@sigrun/sigrun/blocks` and returns a tree whose `v` equals the server's `BLOCK_SET_VERSION`;
  - an extension whose own `node_modules/sigrun` has a different version is quarantined with the same message shape pi-durable skew produces;
  - `SIGRUN_DEV=1` → `/v1/meta` has `dev: true`; unset → `false`; `SIGRUN_DEV=yes` → boot error naming the variable.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test && npm run typecheck && npm run build` — PASS; `node -e "import('@sigrun/sigrun/blocks')"` from a scratch dir with the package linked resolves.
- [ ] **Step 5: Commit** `git commit -m "blocks: typed builders as @sigrun/sigrun/blocks; sigrun linked as a host runtime module"`.
