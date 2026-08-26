import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
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
			CI: "0",
			HOME: directory,
			PATH: `${path.join(directory, "fixtures")}${path.delimiter}${process.env.PATH}`,
			NODE_OPTIONS: `--import=${path.join(root, "test", "tty-shim.mjs")}`,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const closed = new Promise<number | null>((resolve) =>
		child.once("close", resolve),
	);
	let ready = false;
	child.stderr.on("data", (chunk) => {
		ready ||= String(chunk).includes("__OPENAGENTCOUNCIL_TTY_READY__");
	});
	const deadline = Date.now() + 2_000;
	try {
		while (!ready && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 10));
		if (!ready)
			throw new Error(`${path.basename(command)} did not become ready`);
		child.kill("SIGTERM");
		child.stdin.end();
		const code = await Promise.race([
			closed,
			new Promise<never>((_resolve, reject) =>
				setTimeout(
					() => reject(new Error(`${path.basename(command)} did not stop`)),
					2_000,
				),
			),
		]);
		assert.equal(code, 143);
	} finally {
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
		child.stdin.end();
		await closed;
	}
}

test("the packed release installs and runs both executable names", async () => {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "openagentcouncil-release-"),
	);
	const suppliedTarball = process.env.OPENAGENTCOUNCIL_TARBALL;
	let tarball = suppliedTarball ? path.resolve(root, suppliedTarball) : "";
	try {
		if (!tarball) {
			const { stdout } = await execFile(
				"npm",
				["pack", "--json", "--ignore-scripts"],
				{
					cwd: root,
				},
			);
			const packed = JSON.parse(stdout) as [{ filename: string }];
			tarball = path.join(root, packed[0].filename);
		}
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
		for (const executable of ["agentcouncil", "openagentcouncil"]) {
			const runtimeDirectory = path.join(directory, executable);
			const fixtures = path.join(runtimeDirectory, "fixtures");
			await mkdir(fixtures, { recursive: true });
			await Promise.all(
				["codex", "claude"].map(async (name) => {
					const file = path.join(fixtures, name);
					await writeFile(file, "#!/bin/sh\nexit 0\n");
					await chmod(file, 0o700);
				}),
			);
			await waitForSetup(
				path.join(directory, "node_modules", ".bin", executable),
				runtimeDirectory,
			);
		}
	} finally {
		if (tarball && !suppliedTarball) await rm(tarball, { force: true });
		await rm(directory, { recursive: true, force: true });
	}
});
