import type { LoginProviderContribution, LoginResult } from "../../../src/extension.js";
export const fixtureLoginResult: LoginResult;
export const fixtureLoginProvider: LoginProviderContribution;
export function setFixtureLoginProviders(value: unknown): void;
export default function createFixtureLogin(): { name: string; loginProviders: unknown };
