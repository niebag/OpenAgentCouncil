import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { abortOnShutdown } from "../src/shutdown.js";

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

test("shutdown signals unmount the app and set conventional exit codes", () => {
	for (const [signal, exitCode] of [
		["SIGINT", 130],
		["SIGTERM", 143],
	] as const) {
		const target = new EventEmitter() as EventEmitter & { exitCode?: number };
		let unmounted = 0;
		const removeListeners = abortOnShutdown(() => unmounted++, target);

		target.emit(signal);

		assert.equal(unmounted, 1);
		assert.equal(target.exitCode, exitCode);
		removeListeners();
		assert.equal(target.listenerCount(signal), 0);
	}
});
