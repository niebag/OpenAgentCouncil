import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateConfiguration } from "../src/configuration.js";
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
