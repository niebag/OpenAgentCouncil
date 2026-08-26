import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
	readFileSync(path.join(root, "package.json"), "utf8"),
) as {
	bin: Record<string, string>;
};

test("both executable names map to the same built entrypoint", () => {
	assert.equal(packageJson.bin.agentcouncil, "dist/index.js");
	assert.equal(packageJson.bin.openagentcouncil, packageJson.bin.agentcouncil);
});

test("the built entrypoint rejects non-interactive use before rendering", () => {
	const result = spawnSync(
		process.execPath,
		[path.join(root, "dist/index.js")],
		{
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	assert.equal(result.status, 1);
	assert.match(result.stderr, /interactive terminal \(TTY\)/);
	assert.equal(result.stdout, "");
});
