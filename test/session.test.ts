import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	loadResolvedConfiguration,
	validateConfiguration,
} from "../src/configuration.js";
import {
	createSession,
	deterministicFakeAdapter,
	loadSessionMetadata,
	runDeliberation,
	saveSession,
} from "../src/session.js";

const [council] = validateConfiguration(
	{
		version: 1,
		councils: [
			{
				name: "Engineering Council",
				members: [
					{
						handle: "chair",
						role: "Chair",
						provider: "codex",
						profile: "chair.md",
					},
					{
						handle: "researcher",
						role: "Researcher",
						provider: "codex",
						profile: "researcher.md",
					},
					{
						handle: "critic",
						role: "Critic",
						provider: "codex",
						profile: "critic.md",
					},
					{
						handle: "prototyper",
						role: "Prototyper",
						provider: "codex",
						profile: "prototyper.md",
					},
				],
			},
		],
	},
	["codex"],
).councils;

if (!council) throw new Error("Engineering Council fixture is required");

test("loads a custom Council with optional overrides and snapshots its profiles", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "openagentcouncil-"));
	await writeFile(path.join(directory, "chair.md"), "Original Chair Profile");
	await writeFile(
		path.join(directory, "analyst.md"),
		"Original Analyst Profile",
	);
	await writeFile(path.join(directory, "critic.md"), "Original Critic Profile");
	await writeFile(
		path.join(directory, "council.json"),
		JSON.stringify({
			version: 1,
			councils: [
				{
					name: "Product Council",
					members: [
						{
							handle: "chair",
							role: "Chair",
							provider: "codex",
							profile: "chair.md",
						},
						{
							handle: "analyst",
							role: "Analyst",
							provider: "claude",
							model: "sonnet",
							reasoningEffort: "high",
							capabilities: ["web"],
							profile: "analyst.md",
						},
						{
							handle: "critic",
							role: "Critic",
							provider: "codex",
							profile: "critic.md",
						},
					],
				},
			],
		}),
	);

	const { configuration, profileContents } = await loadResolvedConfiguration(
		directory,
		["codex", "claude"],
	);
	const selectedCouncil = configuration.councils[0];
	if (!selectedCouncil) throw new Error("Custom Council fixture is required");
	const session = createSession({
		council: selectedCouncil,
		workingDirectory: "/tmp/workspace",
		profileContents,
	});
	await writeFile(
		path.join(directory, "analyst.md"),
		"Changed Analyst Profile",
	);

	assert.deepEqual(session.council.members[1], {
		handle: "analyst",
		role: "Analyst",
		provider: "claude",
		model: "sonnet",
		reasoningEffort: "high",
		capabilities: ["web"],
		profile: "analyst.md",
		profileContent: "Original Analyst Profile",
	});
	assert.equal(session.council.members[2]?.model, undefined);
	assert.equal(session.council.members[2]?.reasoningEffort, undefined);
	assert.equal(
		session.council.members[1]?.profileContent,
		"Original Analyst Profile",
	);
	const events = await runDeliberation(session, "Should we ship it?");
	assert.equal(
		events.filter(
			(event) => event.kind === "content" && event.entry.kind === "position",
		).length,
		2,
	);
	await rm(directory, { recursive: true, force: true });
});

test("reports independent Council configuration errors together", async () => {
	await assert.rejects(
		async () => loadResolvedConfiguration("/missing", ["codex"]),
		/ENOENT/,
	);
	assert.throws(
		() =>
			validateConfiguration(
				{
					version: 1,
					councils: [
						{
							name: "Broken Council",
							members: [
								{
									handle: "same",
									role: "Chair",
									provider: "unsupported",
									profile: "missing.md",
								},
								{
									handle: "same",
									role: "Chair",
									provider: "claude",
									profile: "other.md",
									capabilities: ["shell"],
								},
							],
						},
					],
				},
				["codex"],
			),
		(error: Error) =>
			/Member same.*provider/.test(error.message) &&
			/Member same.*capabilities/.test(error.message) &&
			/exactly one Chair/.test(error.message) &&
			/at least two non-Chair/.test(error.message) &&
			/duplicate Member Handle/.test(error.message),
	);
});

test("runs and persists a normalized fake Deliberation", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "openagentcouncil-"));
	const session = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {
			"chair.md": "Chair profile",
			"researcher.md": "Researcher profile",
			"critic.md": "Critic profile",
			"prototyper.md": "Prototyper profile",
		},
		now: () => "2026-08-26T12:00:00.000Z",
	});

	const events = await runDeliberation(session, "Should we ship it?", {
		adapter: deterministicFakeAdapter,
		now: () => "2026-08-26T12:01:00.000Z",
	});
	await saveSession(directory, session);

	assert.equal(session.deliberations.length, 1);
	assert.deepEqual(
		session.timeline.map((entry) => entry.kind),
		[
			"question",
			"position",
			"position",
			"draft-recommendation",
			"review",
			"recommendation",
		],
	);
	assert.equal(
		session.timeline.filter((entry) => entry.kind === "position").length,
		2,
	);
	assert.equal(session.timeline.at(-1)?.kind, "recommendation");
	assert.ok(events.some((event) => event.kind === "member-status"));
	assert.ok(events.some((event) => event.kind === "content"));
	assert.doesNotMatch(JSON.stringify(events), /fake-provider/i);

	const file = path.join(directory, "sessions", `${session.id}.json`);
	const before = await readFile(file, "utf8");
	assert.equal(
		(JSON.parse(before) as typeof session).timeline.at(-1)?.kind,
		"recommendation",
	);
	assert.deepEqual(await loadSessionMetadata(directory), [
		{
			id: session.id,
			version: 1,
			startedAt: "2026-08-26T12:00:00.000Z",
			workingDirectory: "/tmp/workspace",
			councilName: "Engineering Council",
		},
	]);
	assert.equal(await readFile(file, "utf8"), before);
	assert.deepEqual(await readdir(path.join(directory, "sessions")), [
		`${session.id}.json`,
	]);
	await rm(directory, { recursive: true, force: true });
});
