import { fileURLToPath } from "node:url";
import { join } from "node:path";

export default function fixtureUserService(host) {
	return {
		extension: { name: "acme" },
		userServices: [
			{
				name: "echo",
				idleMinutes: 0.001,
				async start(user) {
					if (user === "unavailable") return undefined;
					return {
						command: process.execPath,
						args: [join(fileURLToPath(new URL(".", import.meta.url)), "echo.js")],
						env: { SERVICE_TOKEN: `${user}-service-token` },
					};
				},
			},
		],
	};
}
