/**
 * Test-fixture extension package: the built-in quarantine path (Task 2).
 * Its factory THROWS at load, so a boot listing it as a built-in entry
 * must quarantine it exactly like a failing configured extension — one
 * outcome with status "quarantined" and the error, boot continues.
 */

export default function fixtureThrowing() {
	throw new Error("fixture-throwing: deliberately failing factory");
}
