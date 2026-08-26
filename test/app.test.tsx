import { render } from "ink-testing-library";
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { App } from "../src/app.js";
import {
	createEngineeringCouncil,
	loadConfiguration,
} from "../src/configuration.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function providerPath(directory: string, providers: string[]) {
	const binDirectory = path.join(directory, "bin");
	await mkdir(binDirectory);
	await Promise.all(
		providers.map(async (provider) => {
			const executable = path.join(binDirectory, provider);
			await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });
			await chmod(executable, 0o700);
		}),
	);
	return binDirectory;
}

test("renders the production Council screen and caller directory", async () => {
	const configurationDirectory = await mkdtemp(
		path.join(os.tmpdir(), "openagentcouncil-"),
	);
	await createEngineeringCouncil(configurationDirectory, "codex");
	const instance = render(
		createElement(App, {
			workingDirectory: "/tmp/council-workspace",
			configurationDirectory,
			availableProviders: ["codex"],
		}),
	);
	await settle();
	assert.match(instance.lastFrame() ?? "", /OpenAgentCouncil/);
	assert.match(instance.lastFrame() ?? "", /COUNCIL ROSTER/);
	assert.match(instance.lastFrame() ?? "", /\/tmp\/council-workspace/);
	instance.unmount();
	await rm(configurationDirectory, { recursive: true, force: true });
});

test("starts a fresh Session with /new and runs a question", async () => {
	const configurationDirectory = await mkdtemp(
		path.join(os.tmpdir(), "openagentcouncil-"),
	);
	await createEngineeringCouncil(configurationDirectory, "codex");
	const instance = render(
		createElement(App, {
			workingDirectory: "/tmp/council-workspace",
			configurationDirectory,
			availableProviders: ["codex"],
		}),
	);
	await settle();
	instance.stdin.write("/new");
	await settle();
	instance.stdin.write("\r");
	await settle();
	assert.match(instance.lastFrame() ?? "", /Choose a Council/);
	instance.stdin.write("\r");
	await settle();
	assert.match(
		instance.lastFrame() ?? "",
		/Session started: Engineering Council/,
	);
	instance.stdin.write("Should we ship it?");
	await settle();
	instance.stdin.write("\r");
	await settle();
	assert.match(
		instance.lastFrame() ?? "",
		/Recommendation for “Should we ship it\?”/,
	);
	instance.unmount();
	await rm(configurationDirectory, { recursive: true, force: true });
});

test("onboards a Codex Engineering Council and saves its Member Profiles", async () => {
	const configurationDirectory = await mkdtemp(
		path.join(os.tmpdir(), "openagentcouncil-"),
	);
	const pathValue = await providerPath(configurationDirectory, ["codex"]);
	const instance = render(
		createElement(App, {
			workingDirectory: "/tmp/council-workspace",
			configurationDirectory,
			pathValue,
		}),
	);
	await settle();

	assert.match(instance.lastFrame() ?? "", /Set up your Engineering Council/);
	assert.match(instance.lastFrame() ?? "", /Codex/);
	assert.doesNotMatch(instance.lastFrame() ?? "", /Claude Code/);
	instance.stdin.write("\r");
	await settle();
	assert.match(instance.lastFrame() ?? "", /COUNCIL ROSTER/);

	const configuration = await loadConfiguration(configurationDirectory, [
		"codex",
	]);
	assert.deepEqual(
		configuration.councils[0]?.members.map((member) => member.handle),
		["chair", "researcher", "critic", "prototyper"],
	);
	assert.equal(
		configuration.councils[0]?.members.filter(
			(member) => member.role === "Chair",
		).length,
		1,
	);
	await rm(configurationDirectory, { recursive: true, force: true });
	instance.unmount();
});

test("does not create configuration when no supported CLI is available", async () => {
	const configurationDirectory = await mkdtemp(
		path.join(os.tmpdir(), "openagentcouncil-"),
	);
	const pathValue = await providerPath(configurationDirectory, []);
	const instance = render(
		createElement(App, {
			workingDirectory: "/tmp/council-workspace",
			configurationDirectory,
			pathValue,
		}),
	);
	await settle();

	assert.match(instance.lastFrame() ?? "", /Install Codex or Claude Code/);
	await assert.rejects(loadConfiguration(configurationDirectory, []));
	await assert.rejects(
		access(path.join(configurationDirectory, "council.json")),
	);
	await rm(configurationDirectory, { recursive: true, force: true });
	instance.unmount();
});

for (const [name, providers, expected, unexpected] of [
	["Claude-only", ["claude"], /Claude Code/, /Codex/],
	[
		"both CLIs",
		["codex", "claude"],
		/Codex[\s\S]*Claude Code/,
		/Install Codex/,
	],
] as const) {
	test(`shows only ${name} choices in Ink setup`, async () => {
		const configurationDirectory = await mkdtemp(
			path.join(os.tmpdir(), "openagentcouncil-"),
		);
		const pathValue = await providerPath(configurationDirectory, [
			...providers,
		]);
		const instance = render(
			createElement(App, {
				workingDirectory: "/tmp/council-workspace",
				configurationDirectory,
				pathValue,
			}),
		);

		await settle();
		assert.match(instance.lastFrame() ?? "", expected);
		assert.doesNotMatch(instance.lastFrame() ?? "", unexpected);
		instance.unmount();
		await rm(configurationDirectory, { recursive: true, force: true });
	});
}
