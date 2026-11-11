/**
 * `@sigrun/sigrun/settings-schema` — the settings-schema authoring
 * surface (settings rework spec §1/§2): `checkSchema` for load-time
 * validation, `generateForm` for the schema → form translation, and
 * `assertDrawable` so every family repo's test suite can prove its
 * schema never falls back to a JSON box.
 */

export {
	applyDefaults,
	checkStoredSettings,
	type CheckedSettings,
	type SettingsRepair,
} from "./defaults.js";

export { dropBlankOptionalStrings } from "./blanks.js";

export { ENV_KEYWORD, envOf, MODEL_KEYWORD, OVERRIDABLE_KEYWORD } from "./keywords.js";

export {
	assertDrawable,
	checkSchema,
	generateForm,
	type Apply,
	type EnvField,
	type GeneratedForm,
	type JsonSchema,
	type LayoutGroup,
	type SchemaCheck,
	type SecretPath,
} from "./generate.js";
