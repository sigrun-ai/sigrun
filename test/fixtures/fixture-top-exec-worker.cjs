"use strict";
/** Rejects the top-level exec path that the one-path refactor deletes. */
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (line.trim() === "") continue;
		const request = JSON.parse(line);
		if (request.op === "hello") {
			process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, value: { capabilities: { listFiles: false } } })}\n`);
			continue;
		}
		if (request.op === "exec") {
			process.stdout.write(`${JSON.stringify({
				id: request.id,
				ok: false,
				error: {
					kind: "exec",
					code: "unsupported_op",
					message: 'top-level op "exec" is not supported; the worker dispatches only op "result"',
				},
			})}\n`);
			continue;
		}
		process.stdout.write(`${JSON.stringify({
			id: request.id,
			ok: false,
			error: { kind: "file", code: "unsupported_op", message: `unsupported operation ${request.op}` },
		})}\n`);
	}
});
process.stdin.on("end", () => process.exit(0));
