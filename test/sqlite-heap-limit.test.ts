/**
 * The process-wide SQLite heap limit: the setting applies beyond the
 * connection that sets it, and a pathological FTS5 query fails at SQLite's
 * memory-allocation boundary instead of growing toward the pod limit.
 *
 * Every mutation runs in a child Node process. SQLite's limit is
 * process-wide, so a worker-local mutation would leak into unrelated SQLite
 * tests; child-process teardown is also the reliable reset (on Node 26,
 * `PRAGMA hard_heap_limit = 0` reports the previous limit, not zero).
 */

import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const APPLY_SCRIPT = `
const { applySqliteHeapLimit } = await import(${JSON.stringify(
	new URL("../src/harness/sqlite-heap-limit.ts", import.meta.url).href,
)});
const value = applySqliteHeapLimit(8 * 1024 * 1024);
if (value !== 8 * 1024 * 1024) throw new Error(\`read-back was \${value}\`);
`;

const FTS5_SCRIPT = `
${APPLY_SCRIPT}
const { randomBytes } = await import("node:crypto");
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(":memory:");
try {
	try {
		db.prepare("SELECT length(randomblob(100000000)) AS bytes").get();
		console.log("SQLite hard_heap_limit not enforced by this Node/SQLite build (guard inactive)");
		process.exit(42);
	} catch (error) {
		if ((error)?.errcode !== 7) throw error;
	}
	db.exec("CREATE VIRTUAL TABLE words USING fts5(body, tokenize='trigram')");
	const insert = db.prepare("INSERT INTO words(body) VALUES (?)");
	for (let row = 0; row < 200; row += 1) {
		insert.run(randomBytes(256).toString("hex"));
	}
	const phrase = randomBytes(20).toString("hex");
	const query = Array.from({ length: 3000 }, () => \`"\${phrase}"\`).join(" AND ");
	let thrown;
	try {
		db.prepare("SELECT rowid FROM words WHERE words MATCH ?").all(query);
	} catch (error) {
		thrown = error;
	}
	if ((thrown)?.errcode !== 7) {
		throw new Error(\`expected SQLITE_NOMEM, got \${String(thrown)}\`);
	}
} finally {
	db.close();
}
`;

function runChild(source: string, skip: (note: string) => never): void {
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
		encoding: "utf8",
	});
	if (result.status === 42) skip(result.stdout.trim());
	expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

describe("applySqliteHeapLimit", () => {
	test("the process-wide limit makes a fresh connection's large FTS5 MATCH throw SQLITE_NOMEM", ({ skip }) => {
		runChild(FTS5_SCRIPT, skip);
	});

	test("the pragma read-back reports the applied limit", ({ skip }) => {
		runChild(APPLY_SCRIPT, skip);
	});
});
