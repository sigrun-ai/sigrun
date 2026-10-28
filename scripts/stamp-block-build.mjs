/** Record the source inputs behind dist/blocks for sibling-consumer checks. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const blocks = join(root, "src", "blocks");
const sources = readdirSync(blocks, { recursive: true, withFileTypes: true })
	.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
	.map((entry) => join(entry.parentPath, entry.name));
sources.push(join(root, "shared", "src", "blocks", "index.ts"));
sources.sort();
const stamp = {
	algorithm: "sha256",
	sources: Object.fromEntries(sources.map((path) => [
		relative(root, path).replaceAll("\\", "/"),
		createHash("sha256").update(readFileSync(path)).digest("hex"),
	])),
};
writeFileSync(join(root, "dist", "blocks", "build-stamp.json"), `${JSON.stringify(stamp, null, 2)}\n`);
