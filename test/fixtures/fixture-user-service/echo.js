import { writeSync } from "node:fs";

const report = {
	pid: process.pid,
	env: {
		SERVICE_TOKEN: process.env.SERVICE_TOKEN,
		PARENT_SECRET_MUST_NOT_LEAK: process.env.PARENT_SECRET_MUST_NOT_LEAK,
		SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
		HOME: process.env.HOME,
		TMPDIR: process.env.TMPDIR,
		USER: process.env.USER,
	},
	cwd: process.cwd(),
};
writeSync(1, `${JSON.stringify(report)}\n`);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	for (const line of chunk.split("\n")) {
		if (line === "crash") {
			for (let index = 1; index <= 25; index++) writeSync(2, `stderr-${index}\n`);
			process.exit(7);
		}
		if (line !== "") writeSync(1, `echo:${line}\n`);
	}
});
