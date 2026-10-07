/**
 * Test-fixture extension package (Task 9e): a memory-surface extension whose
 * factory THROWS at load time — the loader must quarantine it (the §5
 * `extensions[].status` report) and boot must fall back to the no-op memory
 * default, so `health.memory` stays "ok". Quarantines never double-report
 * into health.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is a factory; this one fails when called.
 */

/** Default export: a memory-shaped factory whose backend is unavailable. */
export default function createBrokenMemory() {
	throw new Error("fixture: memory backend unavailable");
}
