/**
 * A stub MCP server for sigrun-core's built-in-extensions tests: a small
 * Node script speaking the stdio JSON-RPC 2.0 protocol (newline-delimited
 * frames). Adapted from sigrun-ext-mcp's own test/stub-mcp-server.mjs —
 * trimmed to one tool so the test's expectations stay exact.
 *
 * Serves:
 *   - `initialize` → protocol version + server info + tools capability
 *   - `notifications/initialized` → ignored (a notification)
 *   - `tools/list` → one tool: `echo` (a string argument)
 *   - `tools/call` → `echo` returns the greeting text; unknown tools → a
 *     JSON-RPC error
 *
 * Tests point `SIGRUN_MCP_CONFIG` at a temp mcp.json naming
 * `node <this file>` as a server — no network, no npx.
 */

import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
	{
		name: "echo",
		description: "Echo a greeting for a name.",
		inputSchema: {
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		},
	},
];

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const trimmed = line.trim();
	if (trimmed === "") return;
	let frame;
	try {
		frame = JSON.parse(trimmed);
	} catch {
		return;
	}
	if (frame.id === undefined) {
		// A notification (e.g. notifications/initialized): no response.
		return;
	}
	const id = frame.id;
	if (frame.method === "initialize") {
		write({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "stub-mcp", version: "0.1.0" },
			},
		});
		return;
	}
	if (frame.method === "tools/list") {
		write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
		return;
	}
	if (frame.method === "tools/call") {
		const name = frame.params?.name;
		const args = frame.params?.arguments ?? {};
		if (name === "echo") {
			write({
				jsonrpc: "2.0",
				id,
				result: {
					content: [{ type: "text", text: `hello, ${String(args.name)}` }],
				},
			});
		} else {
			write({
				jsonrpc: "2.0",
				id,
				error: { code: -32602, message: `unknown tool: ${String(name)}` },
			});
		}
		return;
	}
	write({
		jsonrpc: "2.0",
		id,
		error: { code: -32601, message: `unknown method: ${String(frame.method)}` },
	});
});

function write(frame) {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}
