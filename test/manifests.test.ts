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
 * The `sigrun:` values block (image-workflow spec §4) owns the extension
 * fleet (seed initContainer), deploy-time tools (tools initContainer +
 * PATH), operator Secret envFrom refs, and the command→args migration the
 * image's ENTRYPOINT trampoline requires — covered by the fleet describes
 * below, with values.schema.json validating the `sigrun:` block only.
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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { beforeAll, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const CHART_DIR = join(import.meta.dirname, "..", "charts", "sigrun");
const COMPOSE_FILE = join(
	import.meta.dirname,
	"..",
	"docker",
	"docker-compose.yaml",
);

/** The published image every deploy artifact names. The chart's tags
 * default to the appVersion, so a default render carries this exact
 * reference — no explicit --set needed (and no REPLACEME to work around). */
const PUBLISHED_IMAGE = "ghcr.io/sigrun-ai/sigrun:0.1.5";

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
	for (const flag of set) args.push("--set", flag);
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

	test("the default render names the published image and carries no REPLACEME", async () => {
		// The chart ships pointing at the release's own image: the tag
		// defaults to the appVersion, so a plain `helm template` (no --set)
		// must carry the exact published reference. REPLACEME is the
		// placeholder this release removed — its return would be a
		// deploy-time 404 on an image that does not exist.
		const { stdout } = await execFileAsync(
			"helm",
			["template", "sigrun", CHART_DIR, "--namespace", "sigrun"],
			{ maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
		);
		expect(stdout).not.toMatch(/REPLACEME/);
		expect(stdout).toContain(`image: ${PUBLISHED_IMAGE}`);
	});

	test("the backup CronJob renders the same published image", async () => {
		const docs = await render(["controllers.backup.enabled=true"]);
		const cron = docs.find((doc) => doc.kind === "CronJob");
		expect(cron).toBeDefined();
		const containers = (
			cron as {
				spec: {
					jobTemplate: {
						spec: { template: { spec: { containers: Array<{ image: string }> } } };
					};
				};
			}
		).spec.jobTemplate.spec.template.spec.containers;
		// One image for the whole deployment: the backup sidecar runs the
		// sigrun image itself (sqlite3 for the snapshot, the S3 client as an
		// npm dependency) rather than a second published image.
		expect(containers.map((container) => container.image)).toEqual([
			PUBLISHED_IMAGE,
		]);
	});

	test("default render: backup + monitoring off, core five kinds", async () => {
		const docs = await render();
		const kinds = docs.map((d) => d.kind).sort();
		// The portable public default: the server + its PVC + service +
		// serviceaccount. The backup CronJob and ServiceMonitor/
		// PrometheusRule are opt-in (the backup needs a reachable S3
		// target or a path; the monitor needs a Prometheus to scrape).
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
						args?: string[];
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
		// command→args migration (spec §4): the image's ENTRYPOINT is the
		// privilege-drop trampoline, and k8s `command:` overrides ENTRYPOINT —
		// `args:` keeps the trampoline in the exec path (it execs straight
		// through when the pod security context already set a non-root uid).
		expect(container.command).toBeUndefined();
		expect(container.args).toEqual(["node", "dist/index.js"]);
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
										command?: string[];
										args?: string[];
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
		// Same command→args migration as the main container: the trampoline
		// stays in the exec path for the CronJob too.
		expect(backup.command).toBeUndefined();
		expect(backup.args).toEqual([
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

	test("SigrunNotReady keys on scrape death, sigrun_up 0, or sigrun_ready 0 (the /metrics exposition)", () => {
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
		// only fires on scrape death. The app's own down signals are OR-ed
		// in: sigrun_up 0 (the inspection failure class) and sigrun_ready 0
		// (core-hardening Task 5: the storage-read failure /readyz 503s on —
		// the process stays up and the scrape stays green, so without the
		// gauge nothing pages).
		const notReady = alerts.find((r) => r.alert === "SigrunNotReady");
		expect(notReady?.expr).toBe(
			'up{job="sigrun"} == 0 or sigrun_up == 0 or sigrun_ready == 0',
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

// ---------------------------------------------------------------------------
// sigrun: values block (spec §4) — extension fleet, secrets refs, deploy-time
// tools, and the command→args ENTRYPOINT migration
// ---------------------------------------------------------------------------

/** The fleet/tools overlay (the spec §4 example values, neutralized). */
const FLEET_OVERLAY = {
	sigrun: {
		extensions: {
			enabled: ["npm:@sigrun/memory-markdown@^0.1.0"],
			settings: {
				"memory-markdown": { noteRoot: "/data/notes" },
			},
		},
		tools: {
			enabled: true,
			packages: ["kubectl@v1.32.0"],
		},
		secretsEnv: ["my-sec"],
	},
};

type FleetPodSpec = {
	initContainers?: {
		name: string;
		image: string;
		args: string[];
		volumeMounts: { name: string; mountPath: string }[];
	}[];
	containers: {
		name: string;
		command?: string[];
		args?: string[];
		env: { name: string; value?: string }[];
		envFrom: { secretRef: { name: string } }[];
	}[];
};

describe("sigrun fleet values (spec §4)", () => {
	let pod!: FleetPodSpec;

	beforeAll(async () => {
		const deployment = docOf(await renderWith(FLEET_OVERLAY), "Deployment") as {
			spec: { template: { spec: FleetPodSpec } };
		};
		pod = deployment.spec.template.spec;
	});

	test("exactly one seed + one tools initContainer, each on the app image with /data mounted", () => {
		expect(pod.initContainers?.map((c) => c.name).sort()).toEqual([
			"sigrun-seed",
			"sigrun-tools",
		]);
		for (const init of pod.initContainers ?? []) {
			// One image for the whole deployment — the seed/tools scripts ship
			// in it at /usr/local/share/sigrun/. Both targets live on the /data
			// PVC, which the library's persistence globalMounts lands on
			// initContainers too (under the pod security context).
			expect(init.image).toBe(PUBLISHED_IMAGE);
			expect(
				init.volumeMounts.some((m) => m.mountPath === "/data"),
				`${init.name} must mount /data`,
			).toBe(true);
		}
	});

	test("seed argv: script, config dir, then the three rendered JSON documents (toJson, never omitted)", () => {
		// seed-settings.sh CONFIG_DIR FLEET_JSON SETTINGS_JSON EXT_SETTINGS_JSON
		// — argv 2-4 are rendered JSON strings, `[]`/`{}` when empty.
		const seed = pod.initContainers?.find((c) => c.name === "sigrun-seed");
		expect(seed?.args).toEqual([
			"/usr/local/share/sigrun/seed-settings.sh",
			"/data/config",
			'["npm:@sigrun/memory-markdown@^0.1.0"]',
			"{}",
			'{"memory-markdown":{"noteRoot":"/data/notes"}}',
		]);
	});

	test("tools argv: script, dir, then every name@version spec", () => {
		// Zero specs never renders — tools-install.sh treats that as a usage
		// error ON PURPOSE (fail loud), so the chart gates on a non-empty
		// packages list rather than shipping a guaranteed CrashLoop.
		const tools = pod.initContainers?.find((c) => c.name === "sigrun-tools");
		expect(tools?.args).toEqual([
			"/usr/local/share/sigrun/tools-install.sh",
			"/data/tools",
			"kubectl@v1.32.0",
		]);
	});

	test("main container: no command (the ENTRYPOINT trampoline stays in the exec path), args carry the deploy entry", () => {
		const main = pod.containers.find((c) => c.name === "main");
		expect(main?.command).toBeUndefined();
		expect(main?.args).toEqual(["node", "dist/index.js"]);
	});

	test("PATH prepends the tools bin dir ahead of the image default", () => {
		const path = pod.containers
			.find((c) => c.name === "main")
			?.env.find((e) => e.name === "PATH");
		// tools-install.sh lands binaries in <dir>/bin.
		expect(path?.value).toMatch(/^\/data\/tools\/bin:/);
		// The image's standard dirs must survive the prepend (k8s env values
		// replace PATH wholesale — there is no $(PATH) reference form).
		expect(path?.value).toContain(":/usr/local/bin:");
	});

	test("envFrom gains each secretsEnv Secret alongside sigrun-env", () => {
		const envFrom = pod.containers.find((c) => c.name === "main")?.envFrom;
		expect(envFrom?.some((e) => e.secretRef.name === "my-sec")).toBe(true);
		expect(envFrom?.some((e) => e.secretRef.name === "sigrun-env")).toBe(
			true,
		);
	});

	test("backup CronJob carries the backup entry as args (no command)", async () => {
		const overlay = {
			...FLEET_OVERLAY,
			controllers: { backup: { enabled: true } },
		};
		const cron = docOf(await renderWith(overlay), "CronJob") as {
			spec: {
				jobTemplate: {
					spec: {
						template: { spec: { containers: FleetPodSpec["containers"] } },
				};
			};
			};
		};
		const backup = cron.spec.jobTemplate.spec.template.spec.containers[0];
		expect(backup.command).toBeUndefined();
		expect(backup.args).toEqual(["node", "/app/dist/backup/run-backup.js"]);
	});
});

describe("sigrun fleet values: the portable default renders nothing", () => {
	test("default render: no initContainers, no tools PATH", async () => {
		// The public default is initContainer-free: nothing to seed (all
		// fleet keys empty) and no tools declared — the seeding path is an
		// operator opt-in, like backup and monitoring.
		const deployment = docOf(await render(), "Deployment") as {
			spec: { template: { spec: FleetPodSpec } };
		};
		const spec = deployment.spec.template.spec;
		expect(spec.initContainers).toBeUndefined();
		expect(
			spec.containers
				.find((c) => c.name === "main")
				?.env.find((e) => e.name === "PATH"),
		).toBeUndefined();
	});

	test("tools without a fleet still renders the tools initContainer", async () => {
		// Regression (self-review): a dangling dependsOn ("sigrun-seed" absent
		// from the library's topological graph) made the library drop the
		// tools container entirely — a tools-only deployment got nothing.
		const overlay = { sigrun: { tools: { packages: ["kubectl@v1.32.0"] } } };
		const deployment = docOf(await renderWith(overlay), "Deployment") as {
			spec: { template: { spec: FleetPodSpec } };
		};
		expect(
			deployment.spec.template.spec.initContainers?.map((c) => c.name),
		).toEqual(["sigrun-tools"]);
	});
});

describe("sigrun values schema (values.schema.json)", () => {
	test("fleet list must be an array — a scalar fails values validation", async () => {
		await expect(
			render(["sigrun.extensions.enabled=notanarray"]),
		).rejects.toThrow(/schema|Invalid type/i);
	});

	test("tool specs must be name@version", async () => {
		await expect(
			render(["sigrun.tools.packages[0]=notaspec"]),
		).rejects.toThrow(/schema|pattern|does not match/i);
	});

	test("everything outside sigrun: passes through — deep bjw-s overrides still render", async () => {
		const docs = await render(["controllers.backup.enabled=true"]);
		expect(docs.some((d) => d.kind === "CronJob")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// docker/docker-compose.yaml — the smoke / single-node path
// ---------------------------------------------------------------------------

describe("docker compose reference", () => {
	// The structural assertions below parse the YAML directly (no
	// docker/compose binary in the loop) — compose interpolation is not
	// evaluated, so the assertions match the literal interpolation
	// expressions as written (spec §6: `user:`/image tag parametrized,
	// SIGRUN_EXTENSIONS passthrough, hardening set).
	async function composeDoc(): Promise<Record<string, any>> {
		const text = await readFile(COMPOSE_FILE, "utf8");
		return YAML.parse(text) as Record<string, any>;
	}

	test("parses, and its service names the published image with no build stanza", async () => {
		// `docker compose config` is the parser (it validates interpolation
		// and the schema); SIGRUN_DEFAULT_MODEL is a required variable, so
		// the render passes a synthetic one — the literal is this test's own.
		const { stdout } = await execFileAsync(
			"docker",
			["compose", "-f", COMPOSE_FILE, "config"],
			{ timeout: 30_000, env: { ...process.env, SIGRUN_DEFAULT_MODEL: "acme/model" } },
		);
		expect(stdout).toContain(`image: ${PUBLISHED_IMAGE}`);
		// The default is a PULL, not a local build: a friend running
		// `docker compose up` gets the release's image.
		expect(stdout).not.toMatch(/^\s+build:/m);
	});

	test("hardened defaults: read-only rootfs + tmpfs scratch, caps dropped, no-new-privileges, init", async () => {
		const doc = await composeDoc();
		const service = doc.services.sigrun;
		// spec §6: writes are confined to /data (volume), /cache and /tmp
		// (tmpfs) — everything else is read-only (NPM_CONFIG_CACHE is baked
		// to /cache/npm in the image, so npm's cache writes land on tmpfs).
		expect(service.read_only).toBe(true);
		expect(service.tmpfs).toEqual(
			expect.arrayContaining(["/tmp", "/cache"]),
		);
		expect(service.cap_drop).toEqual(["ALL"]);
		expect(service.security_opt).toEqual(["no-new-privileges:true"]);
		// Zombie reaping: the node process never reaps adopted children
		// (git/npm invocations from agent shells) — compose's init makes
		// PID 1 the reaper instead.
		expect(service.init).toBe(true);
	});

	test("image tag and uid/gid are parametrized with the release defaults", async () => {
		const doc = await composeDoc();
		const service = doc.services.sigrun;
		expect(service.image).toBe(
			`ghcr.io/sigrun-ai/sigrun:${"${SIGRUN_IMAGE_TAG:-0.1.5}"}`,
		);
		expect(service.user).toBe("${SIGRUN_UID:-1000}:${SIGRUN_GID:-1000}");
	});

	test("SIGRUN_EXTENSIONS passes through via env_file (unset means absent, not empty)", async () => {
		const doc = await composeDoc();
		const service = doc.services.sigrun;
		// The fleet override env contract: when the var is set it WINS over
		// the settings file's `extensions` list. A literal
		// `${SIGRUN_EXTENSIONS:-}` environment entry would pin an EMPTY
		// fleet over the file when unset (parseExtensionList("") is [],
		// and [] ?? file keeps []), silently killing the file-driven flow
		// the README documents. env_file is the passthrough: present in
		// .env ⇒ in the container, absent from .env ⇒ absent from the
		// container (the chart's envFrom secretRef shape) — asserted BOTH
		// ways: the mechanism present, the footgun shape absent.
		expect(service.env_file).toContainEqual({ path: ".env", required: false });
		expect(service.environment.SIGRUN_EXTENSIONS).toBeUndefined();
	});
});

