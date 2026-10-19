/**
 * charts/sigrun — the bjw-s common (5.2.1) wrapper chart.
 *
 * "Correct" here means (a) `helm lint` passes, (b) the render carries the
 * §4.4 portable invariants (single replica + Recreate + RWO PVC mounted
 * at the storage path + probes wired to /healthz//readyz + envFrom the
 * sigrun Secret + backup CronJob on the same PVC + ServiceMonitor
 * scraping /metrics + PrometheusRule alerts), and (c) the values toggles
 * actually toggle (backup off by default, monitoring off by default,
 * storage class override).
 *
 * The chart delegates Deployment/Service/PVC/CronJob/ServiceMonitor
 * rendering to the bjw-s common library (charts/common-5.2.1.tgz, fetched
 * by `helm dependency update`, gitignored); the PrometheusRule is the one
 * hand template (the library has no PrometheusRule class).
 *
 * The homelab instantiation (iSCSI class, RustFS endpoint, worker
 * placement, kube-prometheus-stack release label) lives in the CONSUMER's
 * GitOps repo as values — deliberately NOT asserted here; the
 * toggle-capability tests use neutral --set values to prove the chart
 * expresses them.
 *
 * Render engine: `helm` (checked once; a missing helm fails loud — the
 * chart IS the manifest, there is no structural fallback).
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { beforeAll, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const CHART_DIR = join(import.meta.dirname, "..", "charts", "sigrun");

/** The image tags are values-shaped (REPLACEME repos, empty tags) — every
 * render passes explicit tags so the library's image validation passes. */
const TAGS = [
	"controllers.main.containers.main.image.tag=v0.1.0-test",
	"controllers.backup.containers.backup.image.tag=v0.1.0-test",
];

/** helm presence — a hard env requirement (no kubectl/kustomize fallback
 * exists: the manifests are templates, not static yaml). */
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
 * shell — no string interpolation of values). `valuesFile` (optional) is
 * written to a temp file and passed as -f — used where --set cannot express
 * the override (helm's `--set env[i]=x` REPLACES the list with a sparse
 * array, nulling the chart's own env entries). */
async function render(
	set: string[] = [],
	valuesFile?: string,
): Promise<Record<string, unknown>[]> {
	expect(await haveHelm(), "helm is required to render charts/sigrun").toBe(
		true,
	);
	const args = ["template", "sigrun", CHART_DIR, "--namespace", "sigrun"];
	for (const flag of [...TAGS, ...set]) args.push("--set", flag);
	if (valuesFile) args.push("-f", valuesFile);
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

/** `helm template` with a values overlay written to a temp file. */
async function renderWith(
	overlay: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-chart-"));
	try {
		const file = join(dir, "overlay.yaml");
		await writeFile(file, YAML.stringify(overlay));
		return await render([], file);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
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

	test("default render: backup + monitoring off, core five kinds", async () => {
		const docs = await render();
		const kinds = docs.map((d) => d.kind).sort();
		// The portable public default: the server + its PVC + service +
		// serviceaccount. The backup CronJob and ServiceMonitor/
		// PrometheusRule are opt-in (the backup needs an image carrying
		// sqlite3+awscli; the monitor needs a Prometheus to scrape).
		expect(kinds).toEqual([
			"Deployment",
			"PersistentVolumeClaim",
			"Service",
			"ServiceAccount",
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
						emptyDir?: Record<string, unknown>;
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
				(c) => c.name === "main",
		) as DeploymentDoc["spec"]["template"]["spec"]["containers"][number];
		expect(container).toBeDefined();
	});

	test("single replica with Recreate strategy (RWO PVC — RollingUpdate deadlocks)", () => {
		expect(deployment.spec.replicas).toBe(1);
		expect(deployment.spec.strategy.type).toBe("Recreate");
	});

	test("entrypoint is the deploy entry: node dist/index.js at /app", () => {
		expect(container.command).toEqual(["node", "dist/index.js"]);
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

	test("store-dir envs: data/state on the PVC mount, cache pod-local", () => {
		// The Tasks 1–7 contract: the explicit SIGRUN_*_DIR envs are used
		// VERBATIM (stores.ts tier 1), so the deployment values ARE the
		// store layout. data + state are the durable buckets — subdirs of
		// the /data PVC mount, next to the db + workspace + config; cache
		// is the regenerable root on its own pod-local volume.
		expect(
			container.env.find((e) => e.name === "SIGRUN_DATA_DIR")?.value,
		).toBe("/data/data");
		expect(
			container.env.find((e) => e.name === "SIGRUN_CACHE_DIR")?.value,
		).toBe("/cache");
		expect(
			container.env.find((e) => e.name === "SIGRUN_STATE_DIR")?.value,
		).toBe("/data/state");
	});

	test("the cache volume is a pod-local emptyDir, never the PVC", () => {
		// Cache is regenerable + self-cleaning (spec §4): a wiped cache is
		// a cold start, not a restore event, and cache is never a backup
		// section — so it mounts an emptyDir, never the sigrun-data claim.
		const cacheMount = container.volumeMounts.find(
			(m) => m.mountPath === "/cache",
		);
		expect(cacheMount).toBeDefined();
		expect(cacheMount?.readOnly).toBeUndefined();
		const cacheVolume = deployment.spec.template.spec.volumes.find(
			(v) => v.name === cacheMount?.name,
		);
		expect(cacheVolume).toBeDefined();
		expect(cacheVolume?.persistentVolumeClaim).toBeUndefined();
		expect(cacheVolume?.emptyDir).toBeDefined();
	});

	test("the data/state/config store roots live on the PVC volume", () => {
		// Every durable root the envs point to (data, state, config — plus
		// SIGRUN_STORAGE_PATH itself) sits under /data, the one PVC mount.
		const env = Object.fromEntries(
			container.env.map((e) => [e.name, e.value]),
		);
		for (const name of [
			"SIGRUN_DATA_DIR",
			"SIGRUN_STATE_DIR",
			"SIGRUN_CONFIG_DIR",
		]) {
			expect(env[name], `${name} must sit under /data`).toMatch(/^\/data\//);
		}
		expect(env["SIGRUN_STORAGE_PATH"]).toBe("/data/sigrun.db");
		const dataMount = container.volumeMounts.find(
			(m) => m.mountPath === "/data",
		);
		const dataVolume = deployment.spec.template.spec.volumes.find(
			(v) => v.name === dataMount?.name,
		);
		expect(dataVolume?.persistentVolumeClaim?.claimName).toBe("sigrun-data");
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

	test("resources: 1Gi memory limit (requests/limits present)", () => {
		// 512Mi request / 1Gi limit — shared with the codemode sandbox's
		// in-process wasm guest heap (the codemode-parity sizing, carried
		// into the chart values).
		expect(container.resources.requests.memory).toBe("512Mi");
		expect(container.resources.limits.memory).toBe("1Gi");
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
		// The ServiceMonitor selects this Service's
		// app.kubernetes.io/service label.
		expect(service.metadata.labels["app.kubernetes.io/service"]).toBe(
			"sigrun",
		);
	});

	test("PVC is RWO, 5Gi, and default render omits the storage class (cluster default)", () => {
		const pvc = docOf(docs, "PersistentVolumeClaim") as {
			metadata: { name: string };
			spec: {
				accessModes: string[];
				storageClassName?: string;
				resources: { requests: { storage: string } };
			};
		};
		expect(pvc.spec.accessModes).toEqual(["ReadWriteOnce"]);
		expect(pvc.spec.resources.requests.storage).toBe("5Gi");
		expect(pvc.spec.storageClassName).toBeUndefined();
		expect(pvc.metadata.name).toBe("sigrun-data");
	});
});

// ---------------------------------------------------------------------------
// CronJob (§4.3): nightly backup on the same PVC (opt-in)
// ---------------------------------------------------------------------------

describe("chart backup CronJob", () => {
	type CronJobDoc = {
		metadata: { name: string };
		spec: {
			schedule: string;
			concurrencyPolicy: string;
			successfulJobsHistoryLimit: number;
			failedJobsHistoryLimit: number;
			jobTemplate: {
				spec: {
					backoffLimit: number;
					template: {
						spec: {
							restartPolicy: string;
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
		cronjob = docOf(
			await render(["controllers.backup.enabled=true"]),
			"CronJob",
		) as CronJobDoc;
	});

	test("nightly schedule, one run at a time (Forbid)", () => {
		expect(cronjob.spec.schedule).toBe("0 4 * * *");
		expect(cronjob.spec.concurrencyPolicy).toBe("Forbid");
		expect(cronjob.spec.successfulJobsHistoryLimit).toBe(3);
		expect(cronjob.spec.failedJobsHistoryLimit).toBe(7);
		expect(cronjob.spec.jobTemplate.spec.backoffLimit).toBe(1);
		expect(cronjob.spec.jobTemplate.spec.template.spec.restartPolicy).toBe(
			"Never",
		);
	});

	test("backup script runs the built entry under plain node against the live db on the shared PVC", () => {
		const pod = cronjob.spec.jobTemplate.spec.template.spec;
		const backup = pod.containers[0];
		expect(backup.command).toEqual([
			"node",
			"/app/dist/backup/run-backup.js",
		]);
		expect(
			backup.env.find((e) => e.name === "SIGRUN_STORAGE_PATH")?.value,
		).toBe("/data/sigrun.db");
		// Section roots (Task 7) resolve via resolveStoreRoots' tier 1 —
		// the same dirs the Deployment pins. Without these, a
		// sections-enabled CronJob resolves configDir to the image's
		// /root/.config/sigrun (HOME defaults) and tars nonexistent dirs.
		// No SIGRUN_CACHE_DIR: cache is never a backup section.
		expect(
			backup.env.find((e) => e.name === "SIGRUN_CONFIG_DIR")?.value,
		).toBe("/data/config");
		expect(
			backup.env.find((e) => e.name === "SIGRUN_DATA_DIR")?.value,
		).toBe("/data/data");
		expect(
			backup.env.find((e) => e.name === "SIGRUN_STATE_DIR")?.value,
		).toBe("/data/state");
		const mount = backup.volumeMounts.find((m) => m.mountPath === "/data");
		expect(mount).toBeDefined();
		// The Deployment's own PVC — the second process touching the sqlite
		// file (App C's named verification class). Found by claim (not
		// index: the cache emptyDir renders first in the volumes list).
		const pvcVolume = pod.volumes.find(
			(v) => v.persistentVolumeClaim !== undefined,
		);
		expect(pvcVolume?.persistentVolumeClaim?.claimName).toBe(
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
// Pod security (§6.10): non-root uid 1000 on BOTH controllers
// ---------------------------------------------------------------------------

describe("chart pod securityContext (§6.10)", () => {
	type PodSpec = { securityContext?: Record<string, number | boolean> };

	test("main Deployment pod: runAsNonRoot, uid/gid/fsGroup 1000 (the image's node user)", async () => {
		// Spec §6.10: the image runs as the base image's node user (uid 1000) —
		// the chart must refuse to schedule it as root, and the fsGroup makes
		// the kubelet chown the sigrun-data PVC to 1000 on mount.
		const deployment = docOf(await render(), "Deployment") as {
			spec: { template: { spec: PodSpec } };
		};
		const sc = deployment.spec.template.spec.securityContext;
		expect(sc?.runAsNonRoot).toBe(true);
		expect(sc?.runAsUser).toBe(1000);
		expect(sc?.runAsGroup).toBe(1000);
		expect(sc?.fsGroup).toBe(1000);
	});

	test("backup CronJob pod: runAsNonRoot, uid/gid/fsGroup 1000", async () => {
		// Same pin on the backup job's pod — it mounts the SAME PVC and
		// must write tars + the sqlite copy as the same non-root uid.
		const cronjob = docOf(
			await render(["controllers.backup.enabled=true"]),
			"CronJob",
		) as {
			spec: { jobTemplate: { spec: { template: { spec: PodSpec } } } };
		};
		const sc = cronjob.spec.jobTemplate.spec.template.spec.securityContext;
		expect(sc?.runAsNonRoot).toBe(true);
		expect(sc?.runAsUser).toBe(1000);
		expect(sc?.runAsGroup).toBe(1000);
		expect(sc?.fsGroup).toBe(1000);
	});
});

// ---------------------------------------------------------------------------
// ServiceMonitor + PrometheusRule (metrics scoping: scrape /metrics)
// ---------------------------------------------------------------------------

describe("chart ServiceMonitor + PrometheusRule", () => {
	const ENABLED = ["serviceMonitor.main.enabled=true", "monitoring.prometheusRule.enabled=true"];
	let docs: Record<string, unknown>[] = [];

	beforeAll(async () => {
		docs = await render(ENABLED);
	});

	test("ServiceMonitor scrapes /metrics on the http port of Service sigrun", () => {
		const monitor = docOf(docs, "ServiceMonitor") as {
			spec: {
				jobLabel: string;
				selector: { matchLabels: Record<string, string> };
				endpoints: { port: string; path: string; interval: string }[];
			};
		};
		expect(monitor.spec.jobLabel).toBe("app.kubernetes.io/name");
		expect(monitor.spec.selector.matchLabels["app.kubernetes.io/service"]).toBe(
			"sigrun",
		);
		expect(monitor.spec.endpoints[0].port).toBe("http");
		// W2 Task 8 (spec §6.9): the scrape target is the full exposition, not
		// the readiness probe — the alerts below key on sigrun_* series.
		expect(monitor.spec.endpoints[0].path).toBe("/metrics");
		expect(monitor.spec.endpoints[0].interval).toBe("30s");
	});

	test("SigrunNotReady keys on scrape death or sigrun_up 0 (the /metrics exposition)", () => {
		const rule = docOf(docs, "PrometheusRule") as {
			spec: { groups: { name: string; rules: { alert: string; expr: string }[] }[] };
		};
		const alerts = rule.spec.groups
			.flatMap((g) => g.rules.map((r) => r))
			.sort((a, b) => a.alert.localeCompare(b.alert));
		expect(alerts.map((r) => r.alert)).toContain("SigrunNotReady");
		expect(alerts.map((r) => r.alert)).toContain("SigrunNoScrape");
		// W2 final-review fix: the scrape is /metrics (answers 200 always —
		// even a harness-closed process serves sigrun_up 0), so up==0 alone
		// only fires on scrape death. The app's own down signal (sigrun_up 0,
		// the inspection failure class) is OR-ed in.
		const notReady = alerts.find((r) => r.alert === "SigrunNotReady");
		expect(notReady?.expr).toBe(
			'up{job="sigrun"} == 0 or sigrun_up == 0',
		);
	});

	test("the four §6.9 alerts render (backup stale gated on backup enabled)", async () => {
		const withBackup = await render([...ENABLED, "controllers.backup.enabled=true"]);
		const rule = docOf(withBackup, "PrometheusRule") as {
			spec: {
				groups: {
				name: string;
				rules: { alert: string; expr: string; for?: string }[];
			}[];
			};
		};
		const byName = new Map(
			rule.spec.groups.flatMap((g) => g.rules).map((r) => [r.alert, r]),
		);
		const names = [...byName.keys()];
		for (const name of [
			"SigrunSubmissionWedged",
			"SigrunProviderNotReady",
			"SigrunBackupStale",
			"SigrunJobFailed",
		]) {
			expect(names, `${name} must render when monitoring is on`).toContain(name);
		}
		expect(byName.get("SigrunSubmissionWedged")?.expr).toBe(
			"sigrun_inflight_submission_oldest_seconds > 1800",
		);
		expect(byName.get("SigrunSubmissionWedged")?.for).toBe("5m");
		expect(byName.get("SigrunProviderNotReady")?.expr).toBe(
			'sigrun_provider_ready{status!="ready"} == 1',
		);
		expect(byName.get("SigrunProviderNotReady")?.for).toBe("15m");
		expect(byName.get("SigrunBackupStale")?.expr).toBe(
			"time() - sigrun_backup_last_success_timestamp_seconds > 36*3600",
		);
		// W4 defines the counter; the rule ships here and matches nothing
		// until then (a deliberate inert alert).
		expect(byName.get("SigrunJobFailed")?.expr).toBe(
			'increase(sigrun_job_runs_total{outcome="failed"}[1h]) > 0',
		);

		// The backup alert's gate: backup disabled in values ⇒ the rule is
		// absent (an unbacked deploy would page forever on a series the
		// server legitimately omits); the other three stay.
		const off = await render(ENABLED);
		const offRule = docOf(off, "PrometheusRule") as {
			spec: { groups: { rules: { alert: string }[] }[] };
		};
		const offNames = offRule.spec.groups.flatMap((g) => g.rules.map((r) => r.alert));
		expect(offNames).not.toContain("SigrunBackupStale");
		for (const name of [
			"SigrunSubmissionWedged",
			"SigrunProviderNotReady",
			"SigrunJobFailed",
		]) {
			expect(offNames).toContain(name);
		}
	});

	test("the ServiceMonitor + PrometheusRule are independently gated", async () => {
		// ServiceMonitor only
		const smOnly = await render(["serviceMonitor.main.enabled=true"]);
		expect(smOnly.some((d) => d.kind === "ServiceMonitor")).toBe(true);
		expect(smOnly.some((d) => d.kind === "PrometheusRule")).toBe(false);
		// PrometheusRule only
		const ruleOnly = await render(["monitoring.prometheusRule.enabled=true"]);
		expect(ruleOnly.some((d) => d.kind === "ServiceMonitor")).toBe(false);
		expect(ruleOnly.some((d) => d.kind === "PrometheusRule")).toBe(true);
	});

	test("the main container pins SIGRUN_METRICS_PUBLIC=true (the scrape stays public across W1's pipeline)", async () => {
		// W2 Task 8: the chart scrapes in-cluster; the env pins the W1
		// `metricsPublic` gate true so the pipeline (W1 Task 1) keeps serving
		// the scrape without a principal once it lands.
		const deployment = docOf(await render(), "Deployment") as {
			spec: {
				template: {
					spec: {
						containers: { name: string; env: { name: string; value?: string }[] }[];
					};
				};
			};
		};
		const main = deployment.spec.template.spec.containers.find(
			(c) => c.name === "main",
		);
		expect(
			main?.env.find((e) => e.name === "SIGRUN_METRICS_PUBLIC")?.value,
		).toBe("true");
	});
});

// ---------------------------------------------------------------------------
// Values toggles (neutral --set overrides; the personal homelab values live
// in the consumer repo, flux-app-llm/sigrun)
// ---------------------------------------------------------------------------

describe("values toggles", () => {
	test("backup is opt-in: default render drops the CronJob, enable renders it", async () => {
		const off = await render();
		expect(off.some((d) => d.kind === "CronJob")).toBe(false);
		const on = await render(["controllers.backup.enabled=true"]);
		expect(on.some((d) => d.kind === "CronJob")).toBe(true);
	});

	test("storage class override lands on the PVC", async () => {
		const docs = await render(["persistence.data.storageClass=example-class"]);
		const pvc = docOf(docs, "PersistentVolumeClaim") as {
			spec: { storageClassName: string };
		};
		expect(pvc.spec.storageClassName).toBe("example-class");
	});

	test("extra env passthrough lands on the main container", async () => {
		// A values-file overlay (helm --set env[i] would replace the chart's
		// own env list with a sparse array — values merging is the documented
		// way to append).
		const docs = await renderWith({
			controllers: {
				main: {
					containers: {
						main: {
							env: [{ name: "SIGRUN_EXAMPLE", value: "from-values" }],
						},
					},
				},
			},
		});
		const deployment = docOf(docs, "Deployment") as {
			spec: { template: { spec: { containers: { env: { name: string; value?: string }[] }[] } } };
		};
		expect(
			deployment.spec.template.spec.containers[0].env.find(
				(e) => e.name === "SIGRUN_EXAMPLE",
			)?.value,
		).toBe("from-values");
	});

	test("worker placement passthrough lands on the server pods", async () => {
		const docs = await render([
			"controllers.main.pod.nodeSelector.example-node=worker",
			"controllers.main.pod.tolerations[0].key=example-taint",
			"controllers.main.pod.tolerations[0].operator=Equal",
			"controllers.main.pod.tolerations[0].value=workload",
			"controllers.main.pod.tolerations[0].effect=NoSchedule",
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
	});

	test("monitoring labels passthrough lands on the ServiceMonitor + PrometheusRule", async () => {
		const docs = await render([
			"serviceMonitor.main.enabled=true",
			"monitoring.prometheusRule.enabled=true",
			"serviceMonitor.main.labels.release=example-stack",
			"monitoring.prometheusRule.labels.release=example-stack",
		]);
		const monitor = docOf(docs, "ServiceMonitor") as {
			metadata: { labels: Record<string, string> };
		};
		const rule = docOf(docs, "PrometheusRule") as {
			metadata: { labels: Record<string, string> };
		};
		expect(monitor.metadata.labels.release).toBe("example-stack");
		expect(rule.metadata.labels.release).toBe("example-stack");
	});

	test("Service annotations passthrough lands on the Service", async () => {
		const docs = await render([
			"service.main.annotations.example-annotation=example-value",
		]);
		const service = docOf(docs, "Service") as {
			metadata: { annotations: Record<string, string> };
		};
		expect(service.metadata.annotations["example-annotation"]).toBe(
			"example-value",
		);
	});
});
