/** Login-provider fixture: core owns state; the provider only proves identity. */
export const fixtureLoginResult = {
	subject: "subject-123",
	profile: { username: "fixture-user", name: "Fixture User" },
	groups: ["family"],
};

export const fixtureLoginProvider = {
	id: "fixture",
	label: "Fixture identity",
	icon: "key",
	async begin(flow) {
		flow.data.verifier = "fixture-verifier";
		return { redirectUrl: `https://idp.example.invalid/authorize?state=${flow.state}` };
	},
	async complete() {
		return fixtureLoginResult;
	},
};

let loginProviders = [fixtureLoginProvider];

/** Loader tests replace the declaration before the one dynamic import. */
export function setFixtureLoginProviders(value) {
	loginProviders = value;
}

export default function createFixtureLogin() {
	return { name: "fixture-login", loginProviders };
}
