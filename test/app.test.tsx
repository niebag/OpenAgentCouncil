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
import {
	createSession,
	loadSession,
	runDeliberation,
	saveSession,
} from "../src/session.js";

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

test("selects a configured Council and exposes configuration commands", async () => {
	const configurationDirectory = await mkdtemp(
		path.join(os.tmpdir(), "openagentcouncil-"),
	);
	await createEngineeringCouncil(configurationDirectory, "codex");
	await writeFile(
		path.join(configurationDirectory, "council.json"),
		JSON.stringify({
			version: 1,
			councils: [
				{
					name: "Architecture Council",
					members: [
						{
							handle: "chair",
							role: "Chair",
							provider: "codex",
							profile: "profiles/chair.md",
						},
						{
							handle: "researcher",
							role: "Researcher",
							provider: "codex",
							profile: "profiles/researcher.md",
						},
						{
							handle: "critic",
							role: "Critic",
							provider: "codex",
							profile: "profiles/critic.md",
						},
					],
				},
				{
					name: "Product Council",
					members: [
						{
							handle: "chair",
							role: "Chair",
							provider: "codex",
							profile: "profiles/chair.md",
						},
						{
							handle: "researcher",
							role: "Researcher",
							provider: "codex",
							profile: "profiles/researcher.md",
						},
						{
							handle: "critic",
							role: "Critic",
							provider: "codex",
							profile: "profiles/critic.md",
						},
					],
				},
			],
		}),
	);
	const instance = render(
		createElement(App, {
			workingDirectory: "/tmp/council-workspace",
			configurationDirectory,
			availableProviders: ["codex"],
			openConfiguration: async () => {
				throw new Error("opener unavailable");
			},
		}),
	);
	await settle();
	instance.stdin.write("/config");
	await settle();
	instance.stdin.write("\r");
	await settle();
	assert.match(instance.lastFrame() ?? "", /Configuration: /);
	assert.match(instance.lastFrame() ?? "", /council\.json/);
	instance.stdin.write("/config open");
	await settle();
	instance.stdin.write("\r");
	await settle();
	assert.match(instance.lastFrame() ?? "", /Could not open configuration/);
	assert.match(instance.lastFrame() ?? "", /opener/);
	assert.match(instance.lastFrame() ?? "", /unavailable/);
	instance.stdin.write("/new");
	await settle();
	instance.stdin.write("\r");
	await settle();
	instance.stdin.write("\x1B[B");
	instance.stdin.write("\r");
	await settle();
	assert.match(instance.lastFrame() ?? "", /Session started: Product Council/);
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

test("resumes a saved Session and removes it only after confirmation", async () => {
	const configurationDirectory = await mkdtemp(
		path.join(os.tmpdir(), "openagentcouncil-"),
	);
	const workingDirectory = "/tmp/saved-council-workspace";
	await createEngineeringCouncil(configurationDirectory, "codex");
	const [council] = (await loadConfiguration(configurationDirectory, ["codex"]))
		.councils;
	if (!council) throw new Error("Engineering Council fixture is required");
	const saved = createSession({
		council,
		workingDirectory,
		profileContents: {
			"profiles/chair.md": "Saved Chair profile",
			"profiles/researcher.md": "Saved Researcher profile",
			"profiles/critic.md": "Saved Critic profile",
			"profiles/prototyper.md": "Saved Prototyper profile",
		},
	});
	await runDeliberation(saved, "Revisit the original decision");
	await saveSession(configurationDirectory, saved);
	await rm(path.join(configurationDirectory, "council.json"));
	const instance = render(
		createElement(App, {
			workingDirectory,
			configurationDirectory,
			availableProviders: ["codex"],
		}),
	);
	await settle();
	instance.stdin.write("/resume");
	await settle();
	instance.stdin.write("\r");
	await settle();
	assert.match(instance.lastFrame() ?? "", /Choose a saved Session to resume/);
	assert.match(instance.lastFrame() ?? "", /Engineering Council/);
	assert.match(instance.lastFrame() ?? "", /saved-council-workspace/);
	assert.match(instance.lastFrame() ?? "", /Latest: Revisit the/);
	assert.match(instance.lastFrame() ?? "", /original decision/);
	instance.stdin.write("\r");
	await settle();
	assert.match(
		instance.lastFrame() ?? "",
		/Session started: Engineering Council/,
	);
	instance.stdin.write("What should happen next?");
	await settle();
	instance.stdin.write("\r");
	await settle();
	assert.equal(
		(await loadSession(configurationDirectory, saved.id)).deliberations.length,
		2,
	);
	assert.equal(
		(await loadSession(configurationDirectory, saved.id)).council.members[0]
			?.profileContent,
		"Saved Chair profile",
	);
	instance.unmount();

	await createEngineeringCouncil(configurationDirectory, "codex");
	const removal = render(
		createElement(App, {
			workingDirectory,
			configurationDirectory,
			availableProviders: ["codex"],
		}),
	);
	await settle();
	removal.stdin.write("/remove");
	await settle();
	removal.stdin.write("\r");
	await settle();
	assert.match(removal.lastFrame() ?? "", /Choose a saved Session to remove/);
	removal.stdin.write("\r");
	await settle();
	assert.match(removal.lastFrame() ?? "", /Remove this saved Session/);
	removal.stdin.write("\r");
	await settle();
	assert.equal(
		(await loadSession(configurationDirectory, saved.id)).id,
		saved.id,
	);
	removal.stdin.write("/remove");
	await settle();
	removal.stdin.write("\r");
	await settle();
	removal.stdin.write("\r");
	await settle();
	assert.match(removal.lastFrame() ?? "", /Remove this saved Session/);
	removal.stdin.write("\x1B[B");
	removal.stdin.write("\r");
	await settle();
	assert.match(removal.lastFrame() ?? "", /Removed saved Session/);
	await assert.rejects(loadSession(configurationDirectory, saved.id));
	removal.unmount();
	await rm(configurationDirectory, { recursive: true, force: true });
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
