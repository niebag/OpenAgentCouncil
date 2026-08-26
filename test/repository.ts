import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export async function createTestRepository() {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), "openagentcouncil-repo-"),
	);
	await execFile("git", ["init", "--quiet"], { cwd: directory });
	await writeFile(path.join(directory, "README.md"), "# Fixture\n");
	await execFile("git", ["add", "README.md"], { cwd: directory });
	await execFile(
		"git",
		[
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.com",
			"commit",
			"--quiet",
			"-m",
			"fixture",
		],
		{ cwd: directory },
	);
	return directory;
}
