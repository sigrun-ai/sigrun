# U7 — Image Proxy and Surface Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** External images in any surface load through a same-origin proxy that can't be used as an open proxy or to reach private networks; the TUI gets PNG conversions; and extension authors get "Building surfaces" documentation with checked examples.

**Architecture:**
- **Rewriting:** `src/server/images/rewrite.ts` walks every tree and data object before it leaves the server and replaces `https://…` image sources with signed proxy URLs.
- **Fetching:** `src/server/images/fetch.ts` resolves once, vets every address, and connects only to a vetted address through `node:https` `request` with a custom `lookup`. `undici` is not a dependency; Node's bundled copy backs global `fetch` but can't be imported, so we use `node:https` and add no package.
- **Caching:** `src/server/images/cache.ts` is an LRU under `<cacheDir>/images/`.
- **Routes:** `src/server/routes/images.ts` serves `GET /v1/image` in its signed form (`u`, `e`, `s`) and its source form (`src`), plus `POST /v1/image` for data URLs too long for a query string.

**Tech Stack:** `node:https` (per-request `lookup` and `servername`), `node:dns/promises`, `node:crypto` HMAC-SHA256, `sharp` (new server dependency, ruling 17), Fastify.

**Spec:** `docs/superpowers/specs/2026-10-19-sigrun-ui-blocks-design.md` §11 (all), §14.5, §15 (image proxy), §16 (Images).

**Depends on:** U0 (image source rules), U3 (surface routes to hook the rewrite into). U5 hooks its chat routes into the same rewrite when it lands; if U5 lands first, this plan adds the hook there too.

## Global Constraints

- Signed form: `GET /v1/image?u=<url>&e=<expiry ms>&s=<hex HMAC-SHA256 over u + "\n" + e>[&as=png]`. `e` = signing time + 24 h. Verify on the exact received `u` string, then fetch that same string; never re-encode.
- Key: 32 random bytes at `<stateDir>/image-proxy.key`, mode 0600, created at first boot. Deleting it rotates.
- Source form: `GET /v1/image?src=<asset:slug/path | data:…>[&as=png]`, no signature; `POST /v1/image?as=png` with the `data:` URL as a `text/plain` body. Both authenticated.
- Refused address ranges (IPv4, IPv6, and IPv4-mapped IPv6 forms): `0.0.0.0/8`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, `224.0.0.0/4`, `255.255.255.255/32`, `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`, `ff00::/8`.
- https only, including redirect targets. At most 3 redirects in total. 10 s total timeout. 10 MiB body cap.
- Accepted image types (sniffed from bytes): PNG, JPEG, GIF, WebP. SVG and AVIF refused.
- Cache: `<cacheDir>/images/`, key `sha256(u)` plus `as` variant, 256 MiB LRU, `max-age` clamped to 1 h–7 d.
- Response headers: `Content-Type` of the sniffed type, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=<clamped>`.
- The webui sends no CSP today. Task 3 adds `Content-Security-Policy: img-src 'self' data:` to the webui's HTML responses (`src/server/static.ts`). It has only that one directive, so scripts and styles are untouched.

## Review Focus

1. **DNS rebinding** — a resolver that answers a public address first and `127.0.0.1` second never causes a connection to loopback. Owner: Task 2.
2. **A redirect to `http:` or to a private address** — refused, counted against the budget, and reported as a failed image (the block shows `alt`). Owner: Task 2.
3. **A slow drip response** (1 byte per second) — cut at the 10 s total deadline, not a per-read timeout. Owner: Task 2.
4. **Two surfaces referencing the same URL concurrently** — one upstream fetch, both served from the shared in-flight promise, then from cache. Owner: Task 3.
5. **Cache full while a large image is being written** — eviction never deletes a file currently being served or written. Owner: Task 3.

---

### Task 1: Signing and rewriting

**Files:**
- Create: `src/server/images/sign.ts`, `src/server/images/rewrite.ts`
- Modify: `src/server/surfaces/service.ts` (apply `rewriteImages` to every tree and data response), `src/server/routes/surfaces.ts`
- Test: `test/images-sign.test.ts`, `test/images-rewrite.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function loadOrCreateKey(stateDir: string): Promise<Buffer>;
  export function signUrl(key: Buffer, u: string, now: number): string;      // "/v1/image?u=…&e=…&s=…"
  export function verify(key: Buffer, u: string, e: string, s: string, now: number): boolean;  // constant-time compare
  export function rewriteImages<T extends JsonValue>(value: T, sign: (u: string) => string): T;  // image.src, card image slots, markdown image links
  ```

- [ ] **Step 1: Write failing tests:** the key file is created once with mode 0600 and reused; `verify` accepts a fresh signature, rejects an expired one (`now > e`), a modified `u` (one byte), a modified `e`, and a signature from a different key; `rewriteImages` rewrites `https://` sources in `image` blocks, card `image` slots in data, and `![x](https://…)` in markdown text, and leaves `asset:` and `data:` sources untouched.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "images: HMAC-signed expiring proxy URLs; rewrite https image sources in trees and data"`.

### Task 2: Vetted-address fetching

**Files:**
- Create: `src/server/images/ranges.ts`, `src/server/images/fetch.ts`, `src/server/images/sniff.ts`
- Test: `test/images-fetch.test.ts` (a local TLS server with a self-signed cert trusted only in the test, and an injected resolver)

**Interfaces:**
- Produces:
  ```ts
  export function isRefusedAddress(ip: string): boolean;
  export interface FetchDeps { resolve(host: string): Promise<string[]>; now(): number; ca?: Buffer }
  export function fetchImage(u: string, deps: FetchDeps): Promise<{ bytes: Buffer; type: "png" | "jpeg" | "gif" | "webp"; maxAge?: number }>;
  export function sniffImage(bytes: Buffer): "png" | "jpeg" | "gif" | "webp" | "svg" | "avif" | undefined;
  ```

- [ ] **Step 1: Write failing tests:** `isRefusedAddress` for one address in every refused range and its IPv4-mapped IPv6 form (`::ffff:10.0.0.1`), and `false` for `203.0.113.5` (a documentation range that the test's resolver uses as its stand-in public address); Review Focus 1 (the resolver returns `["203.0.113.5"]` then `["127.0.0.1"]` on any second call; the connection's remote address is the first, asserted via the test server's socket); a host resolving to several addresses where one is private → refused; Review Focus 2 (`http:` redirect refused; a redirect to a private host refused; a fourth redirect refused); Review Focus 3 (drip server cut at 10 s, fake timers); an 11 MiB body → refused at 10 MiB; SVG and AVIF bytes → refused even with an `image/png` content type.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** each hop as one `https.request` whose `lookup` option calls back with the single vetted address for that hop (no agent reuse across hops). `servername` and the `Host` header stay the original host. Redirects are followed by hand: never pass a `follow` option, so every hop goes through the vetting.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `git commit -m "images: rebinding-safe fetch connecting only to vetted addresses; range, redirect, size, time and type limits"`.

### Task 3: Cache, PNG conversion, routes

**Files:**
- Modify: `package.json` (`sharp` in `dependencies`; confirm the Dockerfile's base image runs its prebuilt binary), `Dockerfile` if needed
- Create: `src/server/images/cache.ts`, `src/server/images/convert.ts`, `src/server/routes/images.ts`
- Modify: `src/server/static.ts` (the webui HTML responses carry `Content-Security-Policy: img-src 'self' data:`)
- Test: `test/images-routes.test.ts`, `test/images-cache.test.ts`

- [ ] **Step 1: Write failing tests:** the webui's `index.html` response carries exactly `Content-Security-Policy: img-src 'self' data:`, and the existing e2e smoke still passes with it; unauthenticated → 401; unsigned or expired signed form → 403; a valid signed fetch → 200 with the sniffed type, `nosniff`, clamped `max-age`; the second request is served from `<cacheDir>/images/` without an upstream call; `as=png` converts a JPEG to PNG (check the PNG signature) and caches both variants; the source form serves an asset (containment rules from U3 Task 3 apply: a traversal → 404) and a `data:` URL, both convertible with `as=png`; `POST /v1/image?as=png` with a 200 KiB data URL body → `413` (over the 192 KiB rule) and a 100 KiB one → 200; Review Focus 4 (two concurrent requests → one upstream fetch); Review Focus 5 (fill the cache past 256 MiB with a test-sized cap; a file being streamed is not evicted).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** + `docker build .` locally if the Dockerfile changed — PASS.
- [ ] **Step 5: Commit** `git commit -m "images: proxy routes, LRU cache under cacheDir, sharp PNG conversion for the TUI"`.

### Task 4: "Building surfaces" documentation

**Files:**
- Modify: `docs/extending.md` (new section "Building surfaces": placements table, the block catalog with one builder example each, the three action kinds and the `turn` rule, access and `sharedData`, `changed` and data freshness, uploads and assets, images, settings sections with `apply`, and three complete examples from the sizing pass: a lanes board, a settings section, a dashboard; all code blocks tagged `ts check`)
- Modify: `README.md` (one paragraph pointing to it)
- Test: `test/docs-examples.test.ts` (from U6 Task 4; if U6 hasn't landed, create it here)

- [ ] **Step 1: Write the examples so the docs test fails on a deliberately broken one, then fix it** (proves the test checks them). **Step 2: Run** — PASS.
- [ ] **Step 3: Run** the full gate: `npm test && npm run typecheck && npm --workspace @sigrun/webui run test && npm run typecheck:webui && npm run build:webui && npm --workspace @sigrun/tui run test && npm --workspace @sigrun/tui run typecheck && npm run test:e2e` — PASS.
- [ ] **Step 4: Commit** `git commit -m "docs: building surfaces (catalog, actions, access, settings, three worked examples)"`.
