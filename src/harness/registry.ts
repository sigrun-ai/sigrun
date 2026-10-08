/**
 * Sigrun's extension registry.
 *
 * pi-durable's `createRegistry()` seeds the built-in task definitions
 * (generation, tool, compaction) that `Harness.open` requires. Sigrun-owned
 * extensions will be installed here in later tasks; every harness opened by
 * `openHarness` shares the registry this module creates.
 */

export { createRegistry } from "@earendil-works/pi-durable";
