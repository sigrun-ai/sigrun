/**
 * charts/sigrun — the Helm chart that replaced deploy/ (publish prep 2.5).
 *
 * The chart is the reference deployment (spec §4.4): "correct" here means
 * (a) `helm lint` passes, (b) the default render carries the §4.4 portable
 * invariants (Recreate + single replica + RWO PVC mounted at the storage
 * path + probes wired to /healthz//readyz + envFrom the sigrun Secret +
 * backup CronJob on the same PVC + ServiceMonitor/PrometheusRule scraping
 * /readyz), and (c) the values toggles actually toggle (backup off, tailscale
 * LB on with a distinct component label, monitoring off, storage class
 * override).
 *
 * The homelab instantiation (iSCSI class, RustFS endpoint, worker placement,
 * kube-prometheus-stack release label) lives in the CONSUMER's GitOps repo
 * (flux-app-llm/sigrun) as values — deliberately NOT asserted here; the
 * toggle-capability tests use neutral --set values to prove the chart
 * expresses them.
 *
 * Render engine: `helm` (checked once; a missing helm fails loud — the
 * chart IS the manifest since deploy/ was removed, there is no structural
 * fallback).
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { beforeAll, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const CHART_DIR = join(import.meta.dirname, "..", "charts", "sigrun");

/** helm presence — a hard env requirement (no kubectl/kustomize fallback
 * exists anymore: the manifests are templates, not static yaml). */
let helmAvailable: boolean | undefined;
async function haveHelm(): Promise<boolean> {
	if (helmAvailable !== undefined) return helmAvailable;
	try {
		await execFileAsync("helm", ["version"], { timeout: 10_000 });
		helmAvailable = true;
	} catch {
		helmAvailable = false;
	}
	return helmAvailable;
}

/** `helm template` the chart; `set` entries become --set flags (argv, not
 * shell — no string interpolation of values). */
async function render(
	set: string[] = [],
): Promise<Record<string, unknown>[]> {
	expect(await haveHelm(), "helm is required to render charts/sigrun").toBe(
		true,
	);
	const args = [
		"template",
		"sigrun",
		CHART_DIR,
		"--namespace",
		"sigrun",
	];
	for (const flag of set) args.push("--set", flag);
	const { stdout } = await execFileAsync("helm", args, {
		maxBuffer: 16 * 1024 * 1024,
		timeout: 30_000,
	});
	return stdout
		.split(/^---\s*$/m)
		.map((chunk) => chunk.trim())
		.filter((chunk) => chunk.length > 0)
		.map((chunk) => YAML.parse(chunk) as Record<string, unknown>);
}

/** First doc of a kind from a render. */
function docOf(
	docs: Record<string, unknown>[],
	kind: string,
): Record<string, unknown> {
	const doc = docs.find((d) => d.kind === kind);
	expect(doc, `rendered chart must contain a ${kind}`).toBeDefined();
	return doc as Record<string, unknown>;
}

beforeAll(async () => {
	// Fail loud + early (before every describe asserts against undefined).
	expect(await haveHelm(), "helm must be installed (env requirement)").toBe(
		true,
	);
});

// ---------------------------------------------------------------------------
// lint + default render shape
// ---------------------------------------------------------------------------

describe("charts/sigrun lint + default render", () => {
	test("helm lint passes", async () => {
		expect(await haveHelm()).toBe(true);
		const { stdout, stderr } = await execFileAsync(
			"helm",
			["lint", CHART_DIR],
			{ timeout: 30_000 },
		);
		// helm's success line is "1 chart(s) linted, 0 chart(s) failed";
		// "0 ... failed" is the PASS shape, so assert it positively (a
		// not.match(/failed/i) would match the zero-count success line).
		expect(`${stdout}${stderr}`).toMatch(/1 chart\(s\) linted, 0 chart\(s\) failed/);
	});

	test("default render produces exactly the six §4.4 kinds", async () => {
		const docs = await render();
		const kinds = docs.map((d) => d.kind).sort();
		expect(kinds).toEqual([
			"CronJob",
			"Deployment",
			"PersistentVolumeClaim",
			"PrometheusRule",
			"Service",
			"ServiceMonitor",
		]);
		for (const doc of docs) {
			expect(doc.apiVersion).toBeTruthy();
			expect(doc.kind).toBeTruthy();
		}
	});
});

// ---------------------------------------------------------------------------
// Deployment (§4.4): single replica, Recreate, RWO PVC at storage path,
// probes wired, envFrom the sigrun-env Secret
// ---------------------------------------------------------------------------

describe("chart Deployment", () => {
	type DeploymentDoc = {
		metadata: { name: string };
		spec: {
			replicas: number;
			strategy: { type: string };
			template: {
				spec: {
					containers: {
						name: string;
						command?: string[];
						workingDir?: string;
						env: { name: string; value?: string }[];
						envFrom: { secretRef: { name: string } }[];
						livenessProbe: { httpGet: { path: string; port: string } };
						readinessProbe: { httpGet: { path: string; port: string } };
						resources: {
							requests: { memory: string };
							limits: { memory: string };
						};
						volumeMounts: {
							name: string;
							mountPath: string;
							readOnly?: boolean;
						}[];
					}[];
					volumes: {
						name: string;
						persistentVolumeClaim?: {
								claimName: string;
								readOnly?: boolean;
							};
						}[];
				};
			};
		};
	};

	let deployment!: DeploymentDoc;
	let container!: DeploymentDoc["spec"]["template"]["spec"]["containers"][number];

	beforeAll(async () => {
		deployment = docOf(await render(), "Deployment") as DeploymentDoc;
		container = deployment.spec.template.spec.containers.find(
				(c) => c.name === "sigrun",
		) as DeploymentDoc["spec"]["template"]["spec"]["containers"][number];
		expect(container).toBeDefined();
	});

	test("single replica with Recreate strategy (RWO PVC — RollingUpdate deadlocks)", () => {
		expect(deployment.spec.replicas).toBe(1);
		expect(deployment.spec.strategy.type).toBe("Recreate");
	});

	test("entrypoint is the deploy entry: npx tsx src/index.ts at /app", () => {
		expect(container.command).toEqual(["npx", "tsx", "src/index.ts"]);
		expect(container.workingDir).toBe("/app");
	});

	test("probes wired to /healthz (liveness) and /readyz (readiness)", () => {
		expect(container.livenessProbe.httpGet.path).toBe("/healthz");
		expect(container.livenessProbe.httpGet.port).toBe("http");
		expect(container.readinessProbe.httpGet.path).toBe("/readyz");
		expect(container.readinessProbe.httpGet.port).toBe("http");
	});

	test("the sqlite PVC mounts at /data", () => {
		const dataMount = container.volumeMounts.find(
			(m) => m.mountPath === "/data",
		);
		expect(dataMount?.readOnly).toBeUndefined();
		const dataVolume = deployment.spec.template.spec.volumes.find(
			(v) => v.name === dataMount?.name,
		);
		expect(dataVolume?.persistentVolumeClaim?.claimName).toBe("sigrun-data");
		expect(dataVolume?.persistentVolumeClaim?.readOnly).toBeUndefined();
	});

	test("SIGRUN_STORAGE_PATH points inside the mounted volume", () => {
		const storage = container.env.find(
			(e) => e.name === "SIGRUN_STORAGE_PATH",
		);
		expect(storage?.value).toBe("/data/sigrun.db");
	});

	test("SIGRUN_PORT matches the Service port", () => {
		expect(container.env.find((e) => e.name === "SIGRUN_PORT")?.value).toBe(
			"3000",
		);
	});

	test("env comes from the sigrun-env Secret (extension secrets)", () => {
		expect(
			container.envFrom.some((e) => e.secretRef.name === "sigrun-env"),
		).toBe(true);
	});

	test("resources: 512Mi memory limit (requests/limits present)", () => {
		expect(container.resources.requests.memory).toBe("256Mi");
		expect(container.resources.limits.memory).toBe("512Mi");
	});
});

// ---------------------------------------------------------------------------
// Service + PVC
// ---------------------------------------------------------------------------

describe("chart Service + PVC", () => {
	let docs: Record<string, unknown>[] = [];

	beforeAll(async () => {
		docs = await render();
	});

	test("ClusterIP service named sigrun on the http port 3000", () => {
		const service = docOf(docs, "Service") as {
			metadata: { name: string; labels: Record<string, string> };
			spec: {
				type: string;
				ports: { name: string; port: number; targetPort: string }[];
				selector: Record<string, string>;
			};
		};
		expect(service.metadata.name).toBe("sigrun");
		expect(service.spec.type).toBe("ClusterIP");
		expect(service.spec.ports[0].name).toBe("http");
		expect(service.spec.ports[0].port).toBe(3000);
		expect(service.spec.ports[0].targetPort).toBe("http");
		// The ServiceMonitor selects THIS label pair.
		expect(service.metadata.labels["app.kubernetes.io/component"]).toBe(
			"server",
		);
	});

	test("PVC is RWO, 2Gi, and default render omits the storage class (cluster default)", () => {
		const pvc = docOf(docs, "PersistentVolumeClaim") as {
			metadata: { name: string };
			spec: {
				accessModes: string[];
				storageClassName?: string;
				resources: { requests: { storage: string } };
			};
		};
		expect(pvc.spec.accessModes).toEqual(["ReadWriteOnce"]);
		expect(pvc.spec.resources.requests.storage).toBe("2Gi");
		expect(pvc.spec.storageClassName).toBeUndefined();
		expect(pvc.metadata.name).toBe("sigrun-data");
	});
});

// ---------------------------------------------------------------------------
// CronJob (§4.3): nightly backup on the same PVC
// ---------------------------------------------------------------------------

describe("chart backup CronJob", () => {
	type CronJobDoc = {
		metadata: { name: string };
		spec: {
			schedule: string;
			concurrencyPolicy: string;
			jobTemplate: {
				spec: {
					template: {
						spec: {
							containers: {
								name: string;
								command: string[];
								env: { name: string; value?: string }[];
								envFrom: { secretRef: { name: string } }[];
								volumeMounts: { name: string; mountPath: string }[];
							}[];
							volumes: {
								name: string;
								persistentVolumeClaim?: { claimName: string };
							}[];
						};
					};
				};
			};
		};
	};

	let cronjob!: CronJobDoc;

	beforeAll(async () => {
		cronjob = docOf(await render(), "CronJob") as CronJobDoc;
	});

	test("nightly schedule, one run at a time (Forbid)", () => {
		expect(cronjob.spec.schedule).toBe("0 3 * * *");
		expect(cronjob.spec.concurrencyPolicy).toBe("Forbid");
	});

	test("backup script runs via tsx against the live db on the shared PVC", () => {
		const pod = cronjob.spec.jobTemplate.spec.template.spec;
		const backup = pod.containers[0];
		expect(backup.command).toEqual([
			"npx",
			"tsx",
			"/app/src/backup/run-backup.ts",
		]);
		expect(
			backup.env.find((e) => e.name === "SIGRUN_STORAGE_PATH")?.value,
		).toBe("/data/sigrun.db");
		const mount = backup.volumeMounts.find((m) => m.mountPath === "/data");
		expect(mount).toBeDefined();
		// The Deployment's own PVC — the second process touching the sqlite
		// file (App C's named verification class).
		expect(pod.volumes[0]?.persistentVolumeClaim?.claimName).toBe(
			"sigrun-data",
		);
	});

	test("credentials come from the backup Secret", () => {
		const backup =
			cronjob.spec.jobTemplate.spec.template.spec.containers[0];
		expect(
			backup.envFrom.some((e) => e.secretRef.name === "sigrun-backup"),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// ServiceMonitor + PrometheusRule (metrics scoping: scrape /readyz)
// ---------------------------------------------------------------------------

describe("chart ServiceMonitor + PrometheusRule", () => {
	let docs: Record<string, unknown>[] = [];

	beforeAll(async () => {
		docs = await render();
	});

	test("ServiceMonitor scrapes /readyz on the http port of Service sigrun", () => {
		const monitor = docOf(docs, "ServiceMonitor") as {
			spec: {
				jobLabel: string;
				selector: { matchLabels: Record<string, string> };
				endpoints: { port: string; path: string; interval: string }[];
			};
		};
		expect(monitor.spec.jobLabel).toBe("app.kubernetes.io/name");
		expect(monitor.spec.selector.matchLabels["app.kubernetes.io/name"]).toBe(
			"sigrun",
		);
		expect(monitor.spec.selector.matchLabels["app.kubernetes.io/component"]).toBe(
			"server",
		);
		expect(monitor.spec.endpoints[0].port).toBe("http");
		expect(monitor.spec.endpoints[0].path).toBe("/readyz");
	});

	test("PrometheusRule alerts on scrape failure (readiness 503 ⇒ up=0)", () => {
		const rule = docOf(docs, "PrometheusRule") as {
			spec: { groups: { name: string; rules: { alert: string; expr: string }[] }[] };
		};
		const alerts = rule.spec.groups
			.flatMap((g) => g.rules.map((r) => r))
			.sort((a, b) => a.alert.localeCompare(b.alert));
		expect(alerts.map((r) => r.alert)).toContain("SigrunNotReady");
		expect(alerts.map((r) => r.alert)).toContain("SigrunNoScrape");
		expect(alerts[0].expr).toMatch(/up\{job="sigrun"\}/);
	});
});

// ---------------------------------------------------------------------------
// Values toggles (neutral --set overrides; the personal homelab values live
// in the consumer repo, flux-app-llm/sigrun)
// ---------------------------------------------------------------------------

describe("values toggles", () => {
	test("backup.enabled=false drops the CronJob", async () => {
		const docs = await render(["backup.enabled=false"]);
		expect(docs.some((d) => d.kind === "CronJob")).toBe(false);
	});

	test("monitoring.enabled=false drops ServiceMonitor + PrometheusRule", async () => {
		const docs = await render(["monitoring.enabled=false"]);
		expect(docs.some((d) => d.kind === "ServiceMonitor")).toBe(false);
		expect(docs.some((d) => d.kind === "PrometheusRule")).toBe(false);
	});

	test("storage class override lands on the PVC", async () => {
		const docs = await render(["persistence.storageClassName=example-class"]);
		const pvc = docOf(docs, "PersistentVolumeClaim") as {
			spec: { storageClassName: string };
		};
		expect(pvc.spec.storageClassName).toBe("example-class");
	});

	test("tailscale LB Service: distinct component label, class tailscale, same pod selector", async () => {
		const docs = await render(["service.tailscale.enabled=true"]);
		const services = docs.filter((d) => d.kind === "Service") as {
			metadata: {
				name: string;
				labels: Record<string, string>;
				annotations: Record<string, string>;
			};
			spec: {
				type: string;
				loadBalancerClass?: string;
				selector: Record<string, string>;
			};
		}[];
		expect(services).toHaveLength(2);
		const lb = services.find((s) => s.spec.type === "LoadBalancer");
		expect(lb?.metadata.name).toBe("sigrun-tailscale");
		expect(lb?.spec.loadBalancerClass).toBe("tailscale");
		expect(lb?.metadata.annotations["tailscale.com/hostname"]).toBe("sigrun");
		// The ServiceMonitor's matchLabels ({name, component: server}) must
		// NOT match the LB Service (double-scrape guard).
		expect(lb?.metadata.labels["app.kubernetes.io/component"]).toBe(
			"tailscale-lb",
		);
		expect(lb?.spec.selector["app.kubernetes.io/component"]).toBe("server");
	});

	test("extra env passthrough: sigrun.env + backup.env land on the containers", async () => {
		const docs = await render([
			"sigrun.env.SIGRUN_EXAMPLE=from-values",
			"backup.env.SIGRUN_BACKUP_S3_ENDPOINT=https://example.invalid:3900",
		]);
		const deployment = docOf(docs, "Deployment") as {
			spec: { template: { spec: { containers: { env: { name: string; value?: string }[] }[] } } };
		};
		expect(
			deployment.spec.template.spec.containers[0].env.find(
				(e) => e.name === "SIGRUN_EXAMPLE",
			)?.value,
		).toBe("from-values");
		const cronjob = docOf(docs, "CronJob") as {
			spec: {
				jobTemplate: {
					spec: {
						template: {
							spec: { containers: { env: { name: string; value?: string }[] }[] };
						};
					};
				};
			};
		};
		expect(
			cronjob.spec.jobTemplate.spec.template.spec.containers[0].env.find(
				(e) => e.name === "SIGRUN_BACKUP_S3_ENDPOINT",
			)?.value,
		).toBe("https://example.invalid:3900");
	});

	test("secret names are configurable (sigrun-env / sigrun-backup)", async () => {
		const docs = await render([
			"secret.envName=custom-env",
			"backup.secret.envName=custom-backup",
		]);
		const deployment = docOf(docs, "Deployment") as {
			spec: { template: { spec: { containers: { envFrom: { secretRef: { name: string } }[] }[] } } };
		};
		expect(
			deployment.spec.template.spec.containers[0].envFrom.some(
				(e) => e.secretRef.name === "custom-env",
			),
		).toBe(true);
		const cronjob = docOf(docs, "CronJob") as {
			spec: {
				jobTemplate: {
					spec: {
						template: {
							spec: {
								containers: { envFrom: { secretRef: { name: string } }[] }[];
							};
						};
					};
				};
			};
		};
		expect(
			cronjob.spec.jobTemplate.spec.template.spec.containers[0].envFrom.some(
				(e) => e.secretRef.name === "custom-backup",
			),
		).toBe(true);
	});

	test("monitoring.labels passthrough lands on both monitoring objects", async () => {
		const docs = await render(["monitoring.labels.release=example-stack"]);
		const monitor = docOf(docs, "ServiceMonitor") as {
			metadata: { labels: Record<string, string> };
		};
		const rule = docOf(docs, "PrometheusRule") as {
			metadata: { labels: Record<string, string> };
		};
		expect(monitor.metadata.labels.release).toBe("example-stack");
		expect(rule.metadata.labels.release).toBe("example-stack");
	});

	test("worker placement passthrough lands on the server pods", async () => {
		const docs = await render([
			"nodeSelector.example-node=worker",
			"tolerations[0].key=example-taint",
			"tolerations[0].operator=Equal",
			"tolerations[0].value=workload",
			"tolerations[0].effect=NoSchedule",
			"backup.nodeSelector.example-node=worker",
		]);
		const deployment = docOf(docs, "Deployment") as {
			spec: {
				template: {
					spec: {
						nodeSelector: Record<string, string>;
						tolerations: { key: string; effect: string }[];
					};
				};
			};
		};
		expect(deployment.spec.template.spec.nodeSelector["example-node"]).toBe(
			"worker",
		);
		expect(
			deployment.spec.template.spec.tolerations[0].key,
		).toBe("example-taint");
		const cronjob = docOf(docs, "CronJob") as {
			spec: {
				jobTemplate: {
					spec: {
						template: {
							spec: { nodeSelector: Record<string, string> };
						};
					};
				};
			};
		};
		expect(
			cronjob.spec.jobTemplate.spec.template.spec.nodeSelector?.[
				"example-node"
			],
		).toBe("worker");
	});
});