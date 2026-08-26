import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function waitForSetup(command: string, directory: string) {
	const child = spawn(command, [], {
		cwd: directory,
		env: {
			...process.env,
			HOME: directory,
			PATH: `${path.join(directory, "fixtures")}${path.delimiter}${process.env.PATH}`,
			NODE_OPTIONS: `--import=${path.join(root, "test", "tty-shim.mjs")}`,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk) => (output += String(chunk)));
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`${path.basename(command)} did not render`)),
			2_000,
		);
		child.stdout.on("data", () => {
			if (!output.includes("Set up your Engineering Council")) return;
			clearTimeout(timeout);
			resolve();
		});
	});
	child.kill("SIGTERM");
	assert.equal(
		await new Promise((resolve) => child.once("close", resolve)),
		143,
	);
}

test("the packed release installs and runs both executable names offline", async () => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "openagentcouncil-release-"),
	);
	let tarball = "";
	try {
		const { stdout } = await execFile(
			"npm",
			["pack", "--json", "--ignore-scripts"],
			{
				cwd: root,
			},
		);
		const packed = JSON.parse(stdout) as [{ filename: string }];
		tarball = path.join(root, packed[0].filename);
		const { stdout: files } = await execFile("tar", ["-tzf", tarball]);
		assert.deepEqual(
			files.trim().split("\n").sort(),
			[
				"package/LICENSE",
				"package/README.md",
				"package/package.json",
				"package/dist/app.js",
				"package/dist/child-process.js",
				"package/dist/claude.js",
				"package/dist/codex.js",
				"package/dist/configuration.js",
				"package/dist/index.js",
				"package/dist/session.js",
				"package/dist/shutdown.js",
			].sort(),
		);
		await execFile(
			"npm",
			[
				"install",
				"--prefix",
				directory,
				"--ignore-scripts",
				"--no-audit",
				"--offline",
				tarball,
			],
			{ cwd: root },
		);
		const packageJson = JSON.parse(
			await readFile(
				path.join(
					directory,
					"node_modules",
					"openagentcouncil",
					"package.json",
				),
				"utf8",
			),
		) as { bin: Record<string, string> };
		assert.equal(
			packageJson.bin.agentcouncil,
			packageJson.bin.openagentcouncil,
		);
		const fixtures = path.join(directory, "fixtures");
		await mkdir(fixtures);
		await Promise.all(
			["codex", "claude"].map(async (name) => {
				const file = path.join(fixtures, name);
				await writeFile(file, "#!/bin/sh\nexit 0\n");
				await chmod(file, 0o700);
			}),
		);
		await waitForSetup(
			path.join(directory, "node_modules", ".bin", "agentcouncil"),
			directory,
		);
		await waitForSetup(
			path.join(directory, "node_modules", ".bin", "openagentcouncil"),
			directory,
		);
	} finally {
		if (tarball) await rm(tarball, { force: true });
		await rm(directory, { recursive: true, force: true });
	}
});
