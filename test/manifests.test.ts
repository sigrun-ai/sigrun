/**
 * Task 13: deploy manifests — parse every deploy/ yaml and assert the
 * render-critical fields; render via `kubectl kustomize` when available.
 *
 * The manifests are reference material (render-only; no cluster apply in
 * M1), so "correct" here means: (a) every file parses as YAML, (b) the
 * §4.4 portable invariants are structurally present (Recreate + single
 * replica + RWO PVC mounted at the storage path + probes wired to the right
 * paths + CronJob node placement + ServiceMonitor/PrometheusRule wired to
 * the readiness probe), (c) the BASE renders cleanly, and (d) the homelab
 * OVERLAY renders AND carries the Appendix D instantiation (iSCSI class,
 * Tailscale LB, RustFS backup env, worker placement).
 *
 * Render check: `kubectl kustomize <dir>` (kubectl v1.37 ships kustomize
 * v5.8.1). When kubectl is absent, the suite falls back to structural
 * validation only AND SAYS SO (a skipped render is reported, never silent).
 */

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const DEPLOY_DIR = join(import.meta.dirname, "..", "deploy");
const BASE_DIR = join(DEPLOY_DIR, "base");
const OVERLAY_DIR = join(DEPLOY_DIR, "overlays", "homelab");

/** Every yaml file under deploy/ (base + overlay), parsed. */
async function loadManifests(dir: string): Promise<Map<string, unknown>> {
	const parsed = new Map<string, unknown>();
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory()) {
			const nested = await loadManifests(join(dir, entry.name));
			for (const [path, doc] of nested) {
				parsed.set(`${entry.name}/${path}`, doc);
			}
			continue;
		}
		if (!entry.name.endsWith(".yaml")) continue;
		const text = await readFile(join(dir, entry.name), "utf-8");
		parsed.set(entry.name, YAML.parse(text));
	}
	return parsed;
}

/** The kustomization resources must all parse as k8s docs. */
async function kustomization(dir: string): Promise<{ resources: string[] }> {
	const text = await readFile(join(dir, "kustomization.yaml"), "utf-8");
	return YAML.parse(text) as { resources: string[] };
}

/** kubectl presence (checked once; cached). */
let kubectlAvailable: boolean | undefined;
async function haveKubectl(): Promise<boolean> {
	if (kubectlAvailable !== undefined) return kubectlAvailable;
	try {
		await execFileAsync("kubectl", ["version", "--client"], {
			timeout: 10_000,
		});
		kubectlAvailable = true;
	} catch {
		kubectlAvailable = false;
	}
	return kubectlAvailable;
}

/** Render a kustomize dir; returns rendered yaml or undefined when no kubectl. */
async function render(dir: string): Promise<string | undefined> {
	if (!(await haveKubectl())) return undefined;
	const { stdout } = await execFileAsync("kubectl", ["kustomize", dir], {
		maxBuffer: 16 * 1024 * 1024,
		timeout: 30_000,
	});
	return stdout;
}

/** Collect resource docs from a rendered stream. */
function docsOf(rendered: string): Record<string, unknown>[] {
	return rendered
		.split(/^---\s*$/m)
		.map((chunk) => chunk.trim())
		.filter((chunk) => chunk.length > 0)
		.map((chunk) => YAML.parse(chunk) as Record<string, unknown>);
}

const baseManifests = await loadManifests(BASE_DIR);
const overlayManifests = await loadManifests(OVERLAY_DIR);

// ---------------------------------------------------------------------------
// Base: every manifest parses + kustomization references all of them
// ---------------------------------------------------------------------------

describe("deploy base", () => {
	test("every yaml parses and carries app.kubernetes.io/name: sigrun", () => {
		expect(baseManifests.size).toBeGreaterThan(0);
		for (const [path, doc] of baseManifests) {
			if (path === "kustomization.yaml") continue;
			const labels = (doc as { metadata?: { labels?: Record<string, string> } })
				.metadata?.labels;
			expect(labels?.["app.kubernetes.io/name"], path).toBe("sigrun");
		}
	});

	test("kustomization resources reference exactly the manifest files", async () => {
		const k = await kustomization(BASE_DIR);
		const files = [...baseManifests.keys()].filter(
			(name) => name !== "kustomization.yaml",
		);
		expect([...k.resources].sort()).toEqual(files.sort());
	});
});

// ---------------------------------------------------------------------------
// Deployment (§4.4): single replica, Recreate, RWO PVC at storage path,
// probes wired, backup env from Secret
// ---------------------------------------------------------------------------

describe("deployment.yaml", () => {
	const deployment = baseManifests.get("deployment.yaml") as {
		spec: {
			replicas: number;
			strategy: { type: string };
			template: {
				spec: {
					containers: {
						name: string;
						env: { name: string; value?: string; valueFrom?: unknown }[];
						probe1?: unknown;
						livenessProbe?: { httpGet: { path: string; port: unknown } };
						readinessProbe?: { httpGet: { path: string; port: unknown } };
						volumeMounts: { name: string; mountPath: string }[];
					}[];
					volumes: {
						name: string;
						persistentVolumeClaim?: { claimName: string; readOnly?: boolean };
					}[];
				};
			};
		};
	};
	const container = deployment?.spec?.template?.spec?.containers?.find(
		(c: { name: string }) => c.name === "sigrun",
	);
	// A missing container is itself a render-critical failure — assert
	// presence once so every field assertion below is non-null.
	expect(container).toBeDefined();
	if (container === undefined) throw new Error("sigrun container missing");

	test("single replica with Recreate strategy (RWO PVC — RollingUpdate deadlocks)", () => {
		expect(deployment.spec.replicas).toBe(1);
		expect(deployment.spec.strategy.type).toBe("Recreate");
	});

	test("probes wired to /healthz (liveness) and /readyz (readiness)", () => {
		expect(container.livenessProbe?.httpGet?.path).toBe("/healthz");
		expect(container.readinessProbe?.httpGet?.path).toBe("/readyz");
	});

	test("the sqlite PVC mounts at the storage path", () => {
		const dataMount = container.volumeMounts.find(
			(m) => m.name === "data",
		);
		expect(dataMount?.mountPath).toBe("/data");
		const dataVolume = deployment.spec.template.spec.volumes.find(
			(v) => v.name === "data",
		);
		expect(dataVolume?.persistentVolumeClaim?.claimName).toBe("sigrun-data");
		expect(dataVolume?.persistentVolumeClaim?.readOnly).toBeUndefined();
	});

	test("SIGRUN_STORAGE_PATH points inside the mounted volume", () => {
		const storage = container.env.find((e) => e.name === "SIGRUN_STORAGE_PATH");
		expect(storage?.value).toBe("/data/sigrun.db");
	});

	test("env comes from the sigrun-env Secret (extension secrets)", () => {
		const envFrom = (
			container as unknown as {
				envFrom: { secretRef: { name: string } }[];
			}
		).envFrom;
		expect(
			envFrom.some((e) => e.secretRef.name === "sigrun-env"),
		).toBe(true);
	});

	test("memory sized for the codemode sandbox (Task 8: 512Mi / 1Gi)", () => {
		// The QuickJS sandbox runs wasm in-process; the bump gives model
		// scripts guest-heap headroom. Observed in-image canary footprint
		// ~110 MiB rss — the canary is the floor, not the workload.
		const resources = (
			container as unknown as {
				resources?: {
					requests?: { memory?: string };
					limits?: { memory?: string };
				};
			}
		).resources;
		expect(resources?.requests?.memory).toBe("512Mi");
		expect(resources?.limits?.memory).toBe("1Gi");
	});

	test("command routes through the boot-canary entry script (Task 8)", () => {
		// The image ENTRYPOINT (docker-entry.sh) runs the codemode boot
		// canary, fail loud, before exec'ing the real command — the k8s
		// command field REPLACES ENTRYPOINT, so the manifest must route
		// through it explicitly or the runtime canary never runs.
		const command = (
			container as unknown as { command?: string[]; args?: string[] }
		).command;
		expect(command).toEqual(["/bin/sh", "/app/scripts/docker-entry.sh"]);
	});
});

// ---------------------------------------------------------------------------
// Service + PVC + probes' port target
// ---------------------------------------------------------------------------

describe("service.yaml + pvc.yaml", () => {
	test("ClusterIP service named sigrun on the http port", () => {
		const service = baseManifests.get("service.yaml") as {
			spec: { type: string; ports: { name: string; port: number }[] };
		};
		expect(service.spec.type).toBe("ClusterIP");
		expect(service.spec.ports[0].name).toBe("http");
		expect(service.spec.ports[0].port).toBe(3000);
	});

	test("PVC is RWO with a parameterized storage class", () => {
		const pvc = baseManifests.get("pvc.yaml") as {
			spec: {
				accessModes: string[];
				storageClassName: string;
				resources: { requests: { storage: string } };
			};
		};
		expect(pvc.spec.accessModes).toEqual(["ReadWriteOnce"]);
		expect(pvc.spec.storageClassName).toBeTruthy();
		expect(pvc.spec.resources.requests.storage).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// CronJob (T11): node placement carried, image placeholder documented
// ---------------------------------------------------------------------------

describe("cronjob-backup.yaml", () => {
	const cronjob = baseManifests.get("cronjob-backup.yaml") as {
		metadata: { annotations?: Record<string, string> };
		spec: {
			jobTemplate: {
				spec: {
					template: {
						spec: {
							nodeSelector: Record<string, string>;
							containers: {
								name: string;
								image: string;
							}[];
						};
					};
				};
			};
		};
	};

	test("carries a nodeSelector key (node-bound-PVC placement constraint)", () => {
		// The render-critical requirement (plan Task 13 step 2): the CronJob
		// carries the Deployment's node placement. Base keeps it EMPTY (portable
		// — block-backed PVCs have no node binding); the homelab overlay fills
		// it. Structural presence of the key is what must hold in base.
		expect(
			cronjob.spec.jobTemplate.spec.template.spec,
		).toHaveProperty("nodeSelector");
	});

	test("image placeholder names the required contents (sqlite3 + awscli + tsx)", () => {
		const image = cronjob.spec.jobTemplate.spec.template.spec.containers[0].image;
		expect(image).toMatch(/sqlite3/);
		expect(image).toMatch(/awscli/);
		expect(image).toMatch(/tsx/);
	});
});

// ---------------------------------------------------------------------------
// ServiceMonitor + PrometheusRule (metrics scoping: scrape /readyz)
// ---------------------------------------------------------------------------

describe("servicemonitor.yaml + prometheusrule.yaml", () => {
	test("ServiceMonitor scrapes /readyz on the http port of Service sigrun", () => {
		const monitor = baseManifests.get("servicemonitor.yaml") as {
			spec: {
				selector: { matchLabels: Record<string, string> };
				endpoints: { port: string; path: string }[];
			};
		};
		expect(monitor.spec.selector.matchLabels["app.kubernetes.io/name"]).toBe(
			"sigrun",
		);
		const endpoint = monitor.spec.endpoints[0];
		expect(endpoint.port).toBe("http");
		expect(endpoint.path).toBe("/readyz");
	});

	test("PrometheusRule alerts on scrape failure (readiness 503 ⇒ up=0)", () => {
		const rule = baseManifests.get("prometheusrule.yaml") as {
			spec: { groups: { name: string; rules: { alert: string }[] }[] };
		};
		const alerts = rule.spec.groups
			.flatMap((g) => g.rules.map((r) => r.alert))
			.sort();
		expect(alerts).toContain("SigrunNotReady");
		expect(alerts).toContain("SigrunNoScrape");
	});
});

// ---------------------------------------------------------------------------
// Homelab overlay (Appendix D)
// ---------------------------------------------------------------------------

describe("overlays/homelab", () => {
	test("kustomization references the base + the tailscale Service", async () => {
		const k = await kustomization(OVERLAY_DIR);
		expect(k.resources).toContain("../../base");
		const names = [...overlayManifests.keys()];
		expect(names).toContain("service-tailscale.yaml");
	});

	test("Tailscale LB Service: class tailscale + hostname sigrun → sigrun.tailnet.example.test", () => {
		const svc = overlayManifests.get("service-tailscale.yaml") as {
			spec: { type: string; loadBalancerClass: string };
			metadata: { annotations: Record<string, string> };
		};
		expect(svc.spec.type).toBe("LoadBalancer");
		expect(svc.spec.loadBalancerClass).toBe("tailscale");
		expect(svc.metadata.annotations["tailscale.com/hostname"]).toBe("sigrun");
	});

	test("rendered overlay carries every Appendix D field", async () => {
		const rendered = await render(OVERLAY_DIR);
		if (rendered === undefined) {
			console.warn(
				"[manifests] kubectl absent — overlay render SKIPPED; structural assertions below are the gate",
			);
		}
		const source =
			rendered === undefined
				? YAML.stringify([...overlayManifests.values()])
				: rendered;
		// Appendix D: iSCSI storage class on the PVC.
		expect(source).toContain("REPLACE-storage-class");
		// Appendix D: RustFS S3 backup target env (Deployment + CronJob).
		expect(source).toContain("SIGRUN_BACKUP_S3_BUCKET");
		expect(source).toContain("RUSTFS-ENDPOINT-REMOVED.example.invalid:3900");
		// Appendix D: worker nodeSelector + dedicated=workload toleration.
		expect(source).toContain("node-role.kubernetes.io/worker");
		expect(source).toContain("workload");
	});
});

// ---------------------------------------------------------------------------
// Render check (base) — the plan's step 2
// ---------------------------------------------------------------------------

describe("render check", () => {
	test("kubectl kustomize deploy/base renders without error", async () => {
		const rendered = await render(BASE_DIR);
		if (rendered === undefined) {
			console.warn(
				"[manifests] kubectl absent — base render check SKIPPED (structural validation above is the gate)",
			);
			return;
		}
		const docs = docsOf(rendered);
		const kinds = docs.map((d) => d.kind).sort();
		expect(kinds).toEqual([
			"CronJob",
			"Deployment",
			"PersistentVolumeClaim",
			"PrometheusRule",
			"Service",
			"ServiceMonitor",
		]);
		// The render must be multi-doc and every doc must have apiVersion+kind.
		for (const doc of docs) {
			expect(doc.apiVersion).toBeTruthy();
			expect(doc.kind).toBeTruthy();
		}
	});
});
