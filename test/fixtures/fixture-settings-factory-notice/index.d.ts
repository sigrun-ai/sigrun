import type { DeclaredSettings } from "../../../src/extension.js";
export let declared: DeclaredSettings<Record<string, unknown>, Record<string, unknown>> | undefined;
export let factoryRead: Record<string, unknown> | undefined;
export function reset(): void;
