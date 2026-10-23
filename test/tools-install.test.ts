/**
 * Task 3: the deploy-time tools installer — `docker/tools-install.sh`
 * (image workflow spec §5).
 *
 * Contract under test:
 *
 *   tools-install.sh DIR SPEC...    SPEC = name@version
 *
 * - Fixed URL catalog for kubectl/helm/talosctl/flux/k9s; binaries land
 *   in `DIR/bin` on the DATA VOLUME (never the image — version churn is
 *   a deploy concern, spec §5's user ruling).
 * - `DIR/.catalog-sha` (sha256 of the sorted spec list) short-circuits
 *   unchanged lists: a pre-written correct hash means a full no-op —
 *   pod restarts don't re-download (hermes pattern, kept).
 * - Fail-loud (Review Focus 5): unknown tool name OR failed fetch exits
 *   nonzero NAMING the spec, so the initContainer CrashLoop points at
 *   the exact values line.
 *
 * Offline by construction: the hash short-circuit is exercised with the
 * expected sha PRE-WRITTEN (no run ever fetches), and the failed-fetch
 * case rides the script's documented TEST SEAM `TOOL_URL_OVERRIDE_<NAME>`
 * (a comment in the script names it as such — it is not config surface)
 * pointing a catalog entry at a missing local path — curl -f fails
 * instantly and offline. The catalog itself
 * stays real (official download hosts are code, not test literals).
 *
 * The script runs through `sh` (git keeps docker/*.sh mode 0644 — the
 * image chmods at COPY time; the test must not depend on the exec bit),
 * matching the seed-settings suite's convention.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

/** Promisified execFile for building the tar fixture (tar itself is
 * the tool under observation in that test — building the archive with
 * the same tool is fine, extraction correctness is what's asserted). */
const execFileAsync = (cmd: string, args: readonly string[]) =>
	new Promise<void>((resolve, reject) => {
		execFile(cmd, args, (error) => (error ? reject(error) : resolve()));
	});

/** The member tree inside the helm-shaped fixture: the binary at
 * linux-amd64/helm plus noise files that must NOT leak into bin/. */
async function makeHelmTree(root: string): Promise<string[]> {
	await mkdir(join(root, "linux-amd64"), { recursive: true });
	await writeFile(
		join(root, "linux-amd64", "helm"),
		"#!/bin/sh\nfake-helm\n",
	);
	await writeFile(join(root, "linux-amd64", "README.md"), "noise\n");
	return ["linux-amd64"];
}

/** k9s's release shape: the binary at the ARCHIVE ROOT (no subdir) —
 * the two tar layouts the catalog must tell apart. */
async function makeK9sTree(root: string): Promise<string[]> {
	await writeFile(join(root, "k9s"), "#!/bin/sh\nfake-k9s\n");
	await writeFile(join(root, "LICENSE"), "noise\n");
	return ["k9s", "LICENSE"];
}

/** Repo root (test/ → ..): where docker/tools-install.sh lives. */
const REPO_ROOT = join(import.meta.dirname, "..");

/** The script under test (executed via `sh`, see file header). */
const SCRIPT = join(REPO_ROOT, "docker", "tools-install.sh");

/** One installer invocation's observable outcome (never throws — the
 * assertions own what "failed" means per test). */
interface RunResult {
	readonly code: number;
	readonly stderr: string;
}

/** execFile the installer with a tools dir and spec args. */
function run(
	dir: string,
	specs: readonly string[],
	env: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(
			"sh",
			[SCRIPT, dir, ...specs],
			{
				timeout: 30_000,
				// A minimal env: the seam env vars a test sets explicitly,
				// nothing ambient — the script must not depend on caller
				// environment beyond argv (it runs in an initContainer).
				env: { ...env, PATH: process.env.PATH },
			},
			(error, _stdout, stderr) => {
				resolve({
					code:
						error === null
							? 0
							: typeof error.code === "number"
								? error.code
								: 1,
					stderr,
				});
			},
		);
	});
}

/** The exact bytes the script writes to DIR/.catalog-sha: sha256 of
 * the sorted spec list, one per line, plus the trailing newline
 * (byte-compatible with `sort | sha256sum` — the SET, not the chart's
 * argv order, so reordering values must not re-download). Computed
 * here independently so the test pins the formula, not a captured
 * value. */
function expectedCatalogShaFile(specs: readonly string[]): string {
	return `${createHash("sha256")
		.update(`${[...specs].sort().join("\n")}\n`)
		.digest("hex")}\n`;
}

test("hash short-circuit: a pre-written correct .catalog-sha is a no-op", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-tools-sha-"));
	try {
		const specs = ["kubectl@v1.32.0", "k9s@v0.32.4"];
		// Pre-write the hash the script WOULD write: the first (and only)
		// run must short-circuit BEFORE any fetch — proven by pointing
		// the catalog's URLs at missing local paths via the test seam;
		// even a fetch attempt would fail, so exit 0 here means none
		// happened.
		await writeFile(
			join(dir, ".catalog-sha"),
			expectedCatalogShaFile(specs),
		);
		const result = await run(dir, specs, {
			// file:// to a missing path: fails INSTANTLY and offline (a
		// closed TCP port can hang on networks that drop instead of
		// refusing — unusable in a fast test).
			TOOL_URL_OVERRIDE_KUBECTL: "file:///no/such/kubectl",
			TOOL_URL_OVERRIDE_K9S: "file:///no/such/k9s.tar.gz",
		});
		expect(result.code).toBe(0);
		// The hash file is untouched by the short-circuit (byte-stable).
		expect(await readFile(join(dir, ".catalog-sha"), "utf8")).toBe(
			expectedCatalogShaFile(specs),
		);
		// No bin/ created — nothing was installed, nothing needed to be.
		expect(result.stderr).toBe("");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("fresh dir installs every spec; hash is of the SET, not argv order", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-tools-fresh-"));
	try {
		// Deliberately NON-sorted argv: k9s before kubectl. Both install
		// through local fixtures via the seam (kubectl raw, k9s tarred —
		// one of each shape the catalog carries), and the hash file must
		// match the sorted-set formula, i.e. reordering values later must
		// NOT re-download (the pod-restart short-circuit contract).
		const specs = ["k9s@v0.32.4", "kubectl@v1.32.0"];
		await writeFile(join(dir, "fixture-kubectl"), "#!/bin/sh\nfake-kubectl\n");
		const fixtureTar = join(dir, "fixture-k9s.tar.gz");
		await execFileAsync("tar", [
			"-czf",
			fixtureTar,
			"-C",
			dir,
			...(await makeK9sTree(dir)),
		]);
		const result = await run(dir, specs, {
			// The seam points catalog entries at local fixtures instead of
			// dl.k8s.io / github — no network in the suite.
			TOOL_URL_OVERRIDE_KUBECTL: `file://${dir}/fixture-kubectl`,
			TOOL_URL_OVERRIDE_K9S: `file://${fixtureTar}`,
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		// Both binaries landed in DIR/bin with exec mode preserved.
		expect(await readFile(join(dir, "bin", "kubectl"), "utf8")).toBe(
			"#!/bin/sh\nfake-kubectl\n",
		);
		expect(await readFile(join(dir, "bin", "k9s"), "utf8")).toBe(
			"#!/bin/sh\nfake-k9s\n",
		);
		for (const name of ["kubectl", "k9s"]) {
			const st = await stat(join(dir, "bin", name));
			expect(st.mode & 0o111).not.toBe(0);
		}
		// And the hash file now exists with the exact expected bytes.
		expect(await readFile(join(dir, ".catalog-sha"), "utf8")).toBe(
			expectedCatalogShaFile(specs),
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("tarball spec extracts the member into DIR/bin", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-tools-tarball-"));
	try {
		// A local fixture tarball shaped like helm's release artifact: the
		// binary lives at linux-amd64/helm INSIDE the archive; the catalog
		// carries that member path and only it lands as DIR/bin/helm.
		const fixtureTar = join(dir, "fixture-helm.tar.gz");
		await execFileAsync("tar", [
			"-czf",
			fixtureTar,
			"-C",
			dir,
			...(await makeHelmTree(dir)),
		]);
		const result = await run(dir, ["helm@v3.16.1"], {
			TOOL_URL_OVERRIDE_HELM: `file://${fixtureTar}`,
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		const bin = join(dir, "bin", "helm");
		expect(await readFile(bin, "utf8")).toBe("#!/bin/sh\nfake-helm\n");
		const st = await stat(bin);
		expect(st.mode & 0o111).not.toBe(0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("failed fetch exits nonzero naming the spec", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-tools-fetchfail-"));
	try {
		const result = await run(dir, ["helm@v3.16.1"], {
			// Missing local path through the test seam: curl -f fails
		// instantly and offline, and the script must name the SPEC (not
		// the URL alone) so the CrashLoop event points at the values line.
			TOOL_URL_OVERRIDE_HELM: "file:///no/such/helm.tar.gz",
		});
		expect(result.code).not.toBe(0);
		expect(result.stderr).toMatch(/helm@v3\.16\.1/);
		// A failed install must not leave a hash file behind — a later
		// boot would short-circuit into a half-installed tools dir.
		await expect(
			readFile(join(dir, ".catalog-sha"), "utf8"),
		).rejects.toThrow();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("unknown tool name exits nonzero naming the spec", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-tools-unknown-"));
	try {
		// `foo` is not in the catalog: loud failure naming foo@v1, never
		// a silent skip (an empty tools dir would surface much later as
		// `command not found` in an agent session).
		const result = await run(dir, ["foo@v1"]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toMatch(/foo@v1/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
