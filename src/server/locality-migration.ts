/**
 * Settings split Plan 2 Task 2: one-shot migration of the retired
 * per-model `embeddings.localModels` admin list to the per-extension
 * `localProviders` switch. The migration itself is headless (it runs in
 * openHarness, so CLI-only boots move too); the NOTICE runs from
 * createServer, where the notices service exists.
 */

import type { SettingsStore } from "../harness/settings.js";
import { primaryAdmin } from "../harness/identity/primary-admin.js";
import type { NoticesService } from "../notices/service.js";
import type { OpenedHarness } from "../harness/boot.js";

export interface LocalityMigrationResult {
	/** The extension slugs this migration ADDED (unknown models skipped). */
	readonly migrated: readonly string[];
}

/**
 * Move each listed model's owning extension into `localProviders`, then
 * clear `embeddings.localModels`. With an empty/absent legacy list this
 * is a strict no-op (no settings write), so boot never re-migrates and
 * the reflexive one-notice rule follows. A listed model whose provider
 * is no longer declared NEVER migrates (unknown models skipped).
 */
export function migrateLocalModels(
	store: SettingsStore,
	embeddingOwners: (model: string) => string | undefined,
): LocalityMigrationResult {
	const settings = store.read();
	const legacy = settings.embeddings?.localModels ?? [];
	if (legacy.length === 0) return { migrated: [] };
	const added = new Set<string>();
	for (const model of legacy) {
		const owner = embeddingOwners(model);
		if (owner !== undefined) added.add(owner);
	}
	const migrated = [...added].sort();
	const localProviders = [
		...new Set([...(settings.localProviders ?? []), ...migrated]),
	].sort();
	store.update({
		localProviders,
		...(settings.embeddings === undefined
			? {}
			: { embeddings: { ...settings.embeddings, localModels: [] } }),
	});
	return { migrated };
}

/**
 * Post the migration notice (once — the same replace key makes a repost
 * an idempotent replace). An empty directory has no recipient
 * (`UserNoticeInput.user` is required), so it logs one line instead.
 */
export async function noticeLocalityMigration(deps: {
	opened: Pick<OpenedHarness, "identity" | "localityMigration">;
	notices: NoticesService;
	log?: (line: string) => void;
}): Promise<void> {
	const migrated = deps.opened.localityMigration.migrated;
	if (migrated.length === 0) return;
	const extensions = migrated.join(", ");
	const body = `Local embedding providers moved to localProviders: ${extensions}.`;
	const admin = primaryAdmin(deps.opened.identity.users.list());
	if (admin === undefined) {
		(deps.log ?? console.warn)(`settings: locality migration — ${body}`);
		return;
	}
	await deps.notices.post("core", {
		user: admin.user,
		key: "settings.locality-migrated",
		title: "Local providers moved",
		body,
	});
}
