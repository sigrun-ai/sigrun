"use strict";

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (line === "") continue;
		const request = JSON.parse(line);
		if (request.op === "hello") {
			process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, value: { capabilities: { listFiles: true } } })}\n`);
		} else if (request.op === "result" && request.args[0] === "absolutePath") {
			const result = { ok: true, value: "/tmp" };
			process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, value: result })}\n`);
		} else if (request.op === "result" && request.args[0] === "listFiles") {
			const listing = {
				ok: true,
				value: {
					entries: [
						{ path: "nested", kind: "directory" },
						{ path: "nested/file.txt", kind: "file" },
					],
					truncated: false,
				},
			};
			process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, value: listing })}\n`);
		} else if (request.op === "pid") {
			process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, value: process.pid })}\n`);
		}
	}
});
process.stdin.on("end", () => process.exit(0));
