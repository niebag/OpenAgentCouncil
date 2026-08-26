import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	loadResolvedConfiguration,
	validateConfiguration,
} from "../src/configuration.js";
import {
	appendUserInput,
	createSession,
	deterministicFakeAdapter,
	loadSession,
	loadSessionMetadata,
	removeSession,
	runDeliberation,
	saveSession,
} from "../src/session.js";
import { createTestRepository } from "./repository.js";

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

const execFile = promisify(execFileCallback);

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
	for (const event of events) {
		if (event.kind !== "content") continue;
		assert.ok(
			events.some(
				(candidate) =>
					candidate.kind === "member-status" &&
					candidate.member === event.entry.member &&
					candidate.status === "typing",
			),
		);
	}
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
			deliberationCount: 1,
			latestQuestion: "Should we ship it?",
		},
	]);
	assert.equal(await readFile(file, "utf8"), before);
	assert.deepEqual(await readdir(path.join(directory, "sessions")), [
		`${session.id}.json`,
	]);
	await rm(directory, { recursive: true, force: true });
});

test("approves one Assignment and persists its Artifact and complete repository diff", async () => {
	const workingDirectory = await createTestRepository();
	const configurationDirectory = await mkdtemp(
		path.join(os.tmpdir(), "openagentcouncil-"),
	);
	const session = createSession({
		council,
		workingDirectory,
		profileContents: {},
	});
	await writeFile(path.join(workingDirectory, "README.md"), "dirty before\n");
	await writeFile(
		path.join(workingDirectory, "preexisting.txt"),
		"not Assignment work\n",
	);
	let round = 0;
	const proposal = {
		member: "prototyper",
		goal: "Create runnable evidence",
		expectedFiles: ["prototype.txt"],
	};

	await runDeliberation(session, "Can we prove it?", {
		adapter: {
			...deterministicFakeAdapter,
			control({ phase }) {
				if (phase === "round" && round++ === 0)
					return JSON.stringify({ kind: "propose-assignment", ...proposal });
				return deterministicFakeAdapter.control({ phase } as never);
			},
			async respond(request) {
				if (request.phase !== "assignment")
					return deterministicFakeAdapter.respond(request);
				await writeFile(
					path.join(workingDirectory, "README.md"),
					"# Fixture\n",
				);
				await writeFile(
					path.join(workingDirectory, "prototype.txt"),
					"evidence\n",
				);
				await writeFile(
					path.join(workingDirectory, "unexpected.txt"),
					"visible\n",
				);
				return "Created runnable evidence.";
			},
		},
		onAssignmentProposal(value) {
			assert.deepEqual(value, proposal);
			return Promise.resolve("approved");
		},
	});
	await saveSession(configurationDirectory, session);

	const loaded = await loadSession(configurationDirectory, session.id);
	const artifact = loaded.timeline.find((entry) => entry.kind === "artifact");
	assert.equal(artifact?.deliberationId, "deliberation-1");
	assert.equal(artifact?.member, "prototyper");
	assert.equal(artifact?.content, "Created runnable evidence.");
	assert.equal(artifact?.approval.decision, "approved");
	assert.match(artifact?.diff ?? "", /prototype\.txt/);
	assert.match(artifact?.diff ?? "", /unexpected\.txt/);
	assert.match(artifact?.diff ?? "", /-dirty before/);
	assert.match(artifact?.diff ?? "", /\+# Fixture/);
	assert.doesNotMatch(artifact?.diff ?? "", /preexisting\.txt/);
	assert.deepEqual(
		loaded.timeline
			.filter(
				(entry) =>
					entry.kind === "assignment-proposal" ||
					entry.kind === "assignment-decision" ||
					entry.kind === "artifact",
			)
			.map((entry) => entry.kind),
		["assignment-proposal", "assignment-decision", "artifact"],
	);
	await rm(configurationDirectory, { recursive: true, force: true });
	await rm(workingDirectory, { recursive: true, force: true });
});

test("rejects an Assignment without changing the workspace", async () => {
	const workingDirectory = await createTestRepository();
	const session = createSession({
		council,
		workingDirectory,
		profileContents: {},
	});
	let assignmentRan = false;
	let round = 0;
	await runDeliberation(session, "Should we write it?", {
		adapter: {
			...deterministicFakeAdapter,
			control({ phase }) {
				if (phase === "round" && round++ === 0)
					return JSON.stringify({
						kind: "propose-assignment",
						member: "prototyper",
						goal: "Create evidence",
						expectedFiles: ["evidence.txt"],
					});
				return deterministicFakeAdapter.control({ phase } as never);
			},
			respond(request) {
				if (request.phase === "assignment") assignmentRan = true;
				return deterministicFakeAdapter.respond(request);
			},
		},
		onAssignmentProposal: () => "rejected",
	});

	assert.equal(assignmentRan, false);
	assert.equal(
		session.timeline.find((entry) => entry.kind === "assignment-decision")
			?.decision,
		"rejected",
	);
	assert.equal(
		(await execFile("git", ["status", "--short"], { cwd: workingDirectory }))
			.stdout,
		"",
	);
	await rm(workingDirectory, { recursive: true, force: true });
});

test("never runs two approved Assignments concurrently", async () => {
	const workingDirectory = await createTestRepository();
	const first = createSession({
		council,
		workingDirectory,
		profileContents: {},
	});
	const second = createSession({
		council,
		workingDirectory,
		profileContents: {},
	});
	const rounds = new Map<string, number>();
	let release: () => void = () => {};
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	let started: () => void = () => {};
	const assignmentStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	let secondAssignmentRan = false;
	const adapter = {
		...deterministicFakeAdapter,
		control(input: Parameters<typeof deterministicFakeAdapter.control>[0]) {
			const round = rounds.get(input.question) ?? 0;
			rounds.set(input.question, round + 1);
			if (input.phase === "round" && round === 0)
				return JSON.stringify({
					kind: "propose-assignment",
					member: "prototyper",
					goal: input.question,
					expectedFiles: ["proof.txt"],
				});
			return deterministicFakeAdapter.control(input);
		},
		async respond(
			request: Parameters<typeof deterministicFakeAdapter.respond>[0],
		) {
			if (request.phase !== "assignment")
				return deterministicFakeAdapter.respond(request);
			if (request.question === "First Assignment") {
				started();
				await blocked;
			} else secondAssignmentRan = true;
			return "Artifact complete.";
		},
	};

	const firstRun = runDeliberation(first, "First Assignment", {
		adapter,
		onAssignmentProposal: () => "approved",
	});
	await assignmentStarted;
	await runDeliberation(second, "Second Assignment", {
		adapter,
		onAssignmentProposal: () => "approved",
	});
	assert.equal(secondAssignmentRan, false);
	assert.match(
		second.timeline.find((entry) => entry.kind === "incomplete-deliberation")
			?.content ?? "",
		/already writing/,
	);
	release();
	await firstRun;
	await rm(workingDirectory, { recursive: true, force: true });
});

test("persists the diff when an approved Assignment writes and then fails", async () => {
	const workingDirectory = await createTestRepository();
	const session = createSession({
		council,
		workingDirectory,
		profileContents: {},
	});
	let round = 0;
	await runDeliberation(session, "Try risky evidence", {
		adapter: {
			...deterministicFakeAdapter,
			control({ phase }) {
				if (phase === "round" && round++ === 0)
					return JSON.stringify({
						kind: "propose-assignment",
						member: "prototyper",
						goal: "Create risky evidence",
						expectedFiles: ["partial.txt"],
					});
				return deterministicFakeAdapter.control({ phase } as never);
			},
			async respond(request) {
				if (request.phase !== "assignment")
					return deterministicFakeAdapter.respond(request);
				await writeFile(
					path.join(workingDirectory, "partial.txt"),
					"partial\n",
				);
				throw new Error("fixture crashed");
			},
		},
		onAssignmentProposal: () => "approved",
	});

	const artifact = session.timeline.find((entry) => entry.kind === "artifact");
	assert.match(artifact?.content ?? "", /fixture crashed/);
	assert.match(artifact?.diff ?? "", /partial\.txt/);
	assert.equal(artifact?.approval.decision, "approved");
	await rm(workingDirectory, { recursive: true, force: true });
});

test("gathers Chair-selected Positions independently as they complete", async () => {
	const session = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	const positions = new Map<string, (content: string) => void>();
	const started: string[] = [];
	const events: string[] = [];
	const deliberation = runDeliberation(session, "Should we ship it?", {
		adapter: {
			selectParticipants(input) {
				assert.deepEqual(input.requestedMembers, []);
				return JSON.stringify({
					kind: "select-participants",
					members: ["researcher", "critic"],
				});
			},
			control: deterministicFakeAdapter.control,
			respond({ phase, member, priorContent }) {
				if (phase !== "position") return `${phase} from ${member.handle}`;
				started.push(member.handle);
				assert.deepEqual(priorContent, []);
				return new Promise((resolve) => positions.set(member.handle, resolve));
			},
		},
		onEvent(event) {
			if (event.kind === "content" && event.entry.kind === "position") {
				events.push(event.entry.member);
			}
		},
	});

	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(started, ["researcher", "critic"]);
	assert.equal(
		session.timeline.filter((entry) => entry.kind === "position").length,
		0,
	);
	positions.get("critic")?.("Critic Position");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(events, ["critic"]);
	positions.get("researcher")?.("Researcher Position");
	await deliberation;

	assert.deepEqual(
		session.timeline
			.filter((entry) => entry.kind === "position")
			.map((entry) => entry.member),
		["critic", "researcher"],
	);
	assert.doesNotMatch(JSON.stringify(session.timeline), /select-participants/);
});

test("owns the Chair provider session reference in Deliberation state", async () => {
	const session = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	const references: Array<string | undefined> = [];
	await runDeliberation(session, "Should we ship it?", {
		adapter: {
			selectParticipants: deterministicFakeAdapter.selectParticipants,
			control(request) {
				references.push(request.providerSessionReference);
				return {
					content: JSON.stringify({
						kind:
							request.phase === "round"
								? "draft-recommendation"
								: "finalize-recommendation",
					}),
					providerSessionReference: "chair-native-session",
				};
			},
			respond({ phase, member }) {
				return `${phase} from ${member.handle}`;
			},
		},
	});

	assert.deepEqual(references, [undefined, "chair-native-session"]);
	assert.equal(
		session.deliberations[0]?.providerSessionReferences.chair,
		"chair-native-session",
	);
});

test("cancels a Deliberation as incomplete while preserving completed content", async () => {
	const session = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	const controller = new AbortController();
	const responses = new Map<string, (content: string) => void>();
	const deliberation = runDeliberation(session, "Should we ship it?", {
		signal: controller.signal,
		adapter: {
			selectParticipants: deterministicFakeAdapter.selectParticipants,
			control: deterministicFakeAdapter.control,
			respond({ member }) {
				return new Promise((resolve: (content: string) => void) =>
					responses.set(member.handle, resolve),
				);
			},
		},
	});

	await new Promise((resolve) => setImmediate(resolve));
	responses.get("researcher")?.("Researcher Position");
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort();
	responses.get("critic")?.("Critic Position");
	await deliberation;
	assert.deepEqual(session.deliberations[0]?.outcome, {
		kind: "incomplete-deliberation",
		reason: "cancelled",
	});
	assert.deepEqual(
		session.timeline.map((entry) => entry.kind),
		["question", "position", "incomplete-deliberation"],
	);
});

test("routes additional user input through the Chair in the active Deliberation", async () => {
	const session = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	const responses = new Map<string, (content: string) => void>();
	let chairContent: string[] = [];
	const deliberation = runDeliberation(session, "Should we ship it?", {
		adapter: {
			selectParticipants: deterministicFakeAdapter.selectParticipants,
			control(request) {
				chairContent = request.priorContent;
				return deterministicFakeAdapter.control(request);
			},
			respond(request) {
				if (request.phase !== "position")
					return deterministicFakeAdapter.respond(request);
				return new Promise((resolve: (content: string) => void) =>
					responses.set(request.member.handle, resolve),
				);
			},
		},
	});

	await new Promise((resolve) => setImmediate(resolve));
	appendUserInput(session, "Prioritize a reversible rollout.");
	responses.get("researcher")?.("Researcher Position");
	responses.get("critic")?.("Critic Position");
	await deliberation;

	assert.equal(session.deliberations.length, 1);
	assert.ok(
		session.timeline.some(
			(entry) =>
				entry.kind === "question" &&
				entry.content === "Prioritize a reversible rollout.",
		),
	);
	assert.ok(
		chairContent.some((content) =>
			content.includes("Prioritize a reversible rollout."),
		),
	);
});

test("reroutes input appended during a Chair contribution before completing", async () => {
	const session = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	let startedRecommendation: () => void = () => {};
	const recommendationStarted = new Promise<void>((resolve) => {
		startedRecommendation = resolve;
	});
	let releaseRecommendation: () => void = () => {};
	const chair = session.council.members.find(
		(member) => member.role === "Chair",
	);
	if (!chair) throw new Error("Chair fixture is required");
	const recommendationContent = deterministicFakeAdapter.respond({
		phase: "recommendation",
		member: chair,
		question: "Should we ship?",
		priorContent: [],
		workingDirectory: session.workingDirectory,
		onPartial() {},
	});
	const chairInputs: string[][] = [];
	const deliberation = runDeliberation(session, "Should we ship?", {
		adapter: {
			...deterministicFakeAdapter,
			respond(request) {
				if (request.phase !== "recommendation")
					return deterministicFakeAdapter.respond(request);
				chairInputs.push(request.priorContent);
				if (chairInputs.length > 1) return recommendationContent;
				startedRecommendation();
				return new Promise((resolve) => {
					releaseRecommendation = () => resolve(recommendationContent);
				});
			},
		},
	});

	await recommendationStarted;
	appendUserInput(session, "Include the late rollback constraint.");
	releaseRecommendation();
	await deliberation;

	assert.equal(chairInputs.length, 2);
	assert.ok(
		chairInputs[1]?.some((content) =>
			content.includes("Include the late rollback constraint."),
		),
	);
	assert.deepEqual(session.deliberations[0]?.outcome, {
		kind: "recommendation",
	});
});

test("cancels while the Chair is selecting participants", async () => {
	const session = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	const controller = new AbortController();
	let selectionStarted: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		selectionStarted = resolve;
	});
	const deliberation = runDeliberation(session, "Should we ship?", {
		signal: controller.signal,
		adapter: {
			...deterministicFakeAdapter,
			selectParticipants() {
				selectionStarted();
				return new Promise(() => {});
			},
		},
	});

	await started;
	controller.abort();
	await deliberation;

	assert.deepEqual(session.deliberations[0]?.outcome, {
		kind: "incomplete-deliberation",
		reason: "cancelled",
	});
});

test("repairs Chair selection once and honors direct Member Handle mentions", async () => {
	const session = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	const controls: string[] = [];
	await runDeliberation(session, "Could @prototyper build runnable evidence?", {
		adapter: {
			selectParticipants(input) {
				assert.deepEqual(input.requestedMembers, ["prototyper"]);
				controls.push(input.malformedControl ?? "initial");
				return input.malformedControl
					? JSON.stringify({
							kind: "select-participants",
							members: ["researcher", "prototyper"],
						})
					: "malformed control";
			},
			control: deterministicFakeAdapter.control,
			respond({ phase, member }) {
				return `${phase} from ${member.handle}`;
			},
		},
	});

	assert.equal(controls.length, 2);
	assert.deepEqual(
		session.timeline
			.filter((entry) => entry.kind === "position")
			.map((entry) => entry.member),
		["researcher", "prototyper"],
	);
	assert.doesNotMatch(JSON.stringify(session.timeline), /malformed control/);

	const invalid = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	let attempts = 0;
	await assert.rejects(
		runDeliberation(invalid, "Should we ship it?", {
			adapter: {
				selectParticipants() {
					attempts += 1;
					return "still malformed";
				},
				control: deterministicFakeAdapter.control,
				respond() {
					return "unused";
				},
			},
		}),
		/Chair participant selection must be valid JSON/,
	);
	assert.equal(attempts, 2);
	assert.deepEqual(
		invalid.timeline.map((entry) => entry.kind),
		["question"],
	);

	const punctuationCouncil = {
		...council,
		members: council.members.map((member) =>
			member.handle === "researcher"
				? { ...member, handle: "dev.ops" }
				: member,
		),
	};
	const punctuation = createSession({
		council: punctuationCouncil,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	await runDeliberation(punctuation, "Could (@dev.ops) investigate this?", {
		adapter: {
			selectParticipants(input) {
				assert.deepEqual(input.requestedMembers, ["dev.ops"]);
				return JSON.stringify({
					kind: "select-participants",
					members: ["dev.ops", "critic"],
				});
			},
			control: deterministicFakeAdapter.control,
			respond({ phase, member }) {
				return `${phase} from ${member.handle}`;
			},
		},
	});
});

test("finalizes a reviewed Recommendation after bounded open Rounds", async () => {
	const session = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	let round = 0;
	const recommendation = [
		"## Synthesis",
		"Ship the smaller change.",
		"## Reasoning",
		"The evidence supports it.",
		"## Uncertainty",
		"Production load remains unknown.",
		"## Sources",
		"- https://example.com/research",
		"## Dissent",
		"@critic: wait for load data.",
	].join("\n");

	await runDeliberation(session, "Should we ship it?", {
		adapter: {
			selectParticipants() {
				return JSON.stringify({
					kind: "select-participants",
					members: ["researcher", "critic", "prototyper"],
				});
			},
			control({ phase, priorContent }) {
				if (phase === "finalization") {
					assert.ok(priorContent.some((content) => content.includes("review")));
					return JSON.stringify({ kind: "finalize-recommendation" });
				}
				round += 1;
				return JSON.stringify(
					round === 1
						? { kind: "open-round", members: ["researcher", "critic"] }
						: { kind: "draft-recommendation" },
				);
			},
			respond({ phase, member, priorContent }) {
				if (phase === "position" && member.handle === "prototyper") {
					throw new Error("provider unavailable");
				}
				if (phase === "round") {
					assert.ok(
						priorContent.some((content) => content.includes("position")),
					);
				}
				if (phase === "review") {
					return member.handle === "critic"
						? "Material Dissent: wait for load data."
						: "No material Dissent.";
				}
				if (phase === "recommendation") return recommendation;
				return `${phase} from ${member.handle}`;
			},
		},
	});

	assert.deepEqual(session.deliberations[0]?.outcome, {
		kind: "recommendation",
	});
	assert.equal(
		session.timeline.filter((entry) => entry.kind === "round").length,
		2,
	);
	assert.equal(
		session.timeline.filter((entry) => entry.kind === "review").length,
		3,
	);
	assert.ok(
		session.timeline.some(
			(entry) =>
				entry.kind === "member-failure" && entry.member === "prototyper",
		),
	);
	assert.equal(session.timeline.at(-1)?.content, recommendation);
});

test("enforces finite Round and provider-call budgets", async () => {
	const session = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	let calls = 0;
	await runDeliberation(session, "Keep discussing?", {
		adapter: {
			selectParticipants() {
				calls += 1;
				return JSON.stringify({
					kind: "select-participants",
					members: ["researcher", "critic", "prototyper"],
				});
			},
			control({ phase }) {
				calls += 1;
				return JSON.stringify(
					phase === "round"
						? {
								kind: "open-round",
								members: ["researcher", "critic", "prototyper"],
							}
						: { kind: "finalize-recommendation" },
				);
			},
			respond(request) {
				calls += 1;
				return deterministicFakeAdapter.respond(request);
			},
		},
	});

	assert.equal(
		session.timeline.filter((entry) => entry.kind === "round").length,
		6,
	);
	assert.ok(calls <= 20);
	assert.deepEqual(session.deliberations[0]?.outcome, {
		kind: "recommendation",
	});

	const largeCouncil = {
		name: "Large Council",
		members: [
			council.members[0] as (typeof council.members)[number],
			...Array.from({ length: 25 }, (_, index) => ({
				handle: `member-${index}`,
				role: "Analyst",
				provider: "codex" as const,
				profile: `member-${index}.md`,
			})),
		],
	};
	const exhausted = createSession({
		council: largeCouncil,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	let providerCalls = 0;
	await runDeliberation(exhausted, "Can everyone respond?", {
		adapter: {
			selectParticipants({ members }) {
				providerCalls += 1;
				return JSON.stringify({
					kind: "select-participants",
					members: members
						.filter((member) => member.role !== "Chair")
						.map((member) => member.handle),
				});
			},
			control() {
				providerCalls += 1;
				return JSON.stringify({ kind: "draft-recommendation" });
			},
			respond({ phase, member }) {
				providerCalls += 1;
				return `${phase} from ${member.handle}`;
			},
		},
	});

	assert.equal(providerCalls, 20);
	assert.match(
		exhausted.timeline.at(-1)?.content ?? "",
		/provider-call budget exhausted/,
	);
});

test("persists incomplete outcomes without relabeling partial work", async () => {
	const noQuorum = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	await runDeliberation(noQuorum, "Can we decide?", {
		adapter: {
			selectParticipants() {
				return JSON.stringify({
					kind: "select-participants",
					members: ["researcher", "critic"],
				});
			},
			control: deterministicFakeAdapter.control,
			respond({ phase, member }) {
				if (phase === "position" && member.handle === "critic") {
					throw new Error("critic unavailable");
				}
				return `${phase} from ${member.handle}`;
			},
		},
	});

	assert.deepEqual(noQuorum.deliberations[0]?.outcome, {
		kind: "incomplete-deliberation",
		reason: "missing-quorum",
	});
	assert.deepEqual(
		noQuorum.timeline.map((entry) => entry.kind),
		["question", "position", "member-failure", "incomplete-deliberation"],
	);

	const noReview = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	await runDeliberation(noReview, "Can we decide?", {
		adapter: {
			selectParticipants() {
				return JSON.stringify({
					kind: "select-participants",
					members: ["researcher", "critic"],
				});
			},
			control: deterministicFakeAdapter.control,
			respond({ phase, member }) {
				if (phase === "review") throw new Error("review unavailable");
				return `${phase} from ${member.handle}`;
			},
		},
	});

	assert.deepEqual(noReview.deliberations[0]?.outcome, {
		kind: "incomplete-deliberation",
		reason: "missing-review",
	});
	assert.equal(
		noReview.timeline.filter((entry) => entry.kind === "recommendation").length,
		0,
	);
	assert.equal(noReview.timeline.at(-1)?.kind, "incomplete-deliberation");
	const directory = await mkdtemp(path.join(os.tmpdir(), "openagentcouncil-"));
	await saveSession(directory, noReview);
	assert.deepEqual(
		(await loadSession(directory, noReview.id)).deliberations[0]?.outcome,
		noReview.deliberations[0]?.outcome,
	);
	await rm(directory, { recursive: true, force: true });
});

test("repairs malformed Round and finalization control once", async () => {
	for (const malformedPhase of ["round", "finalization"] as const) {
		const session = createSession({
			council,
			workingDirectory: "/tmp/workspace",
			profileContents: {},
		});
		let attempts = 0;
		await runDeliberation(session, "Can the Chair finish?", {
			adapter: {
				selectParticipants() {
					return JSON.stringify({
						kind: "select-participants",
						members: ["researcher", "critic"],
					});
				},
				control(input) {
					if (input.phase === malformedPhase) {
						attempts += 1;
						if (attempts === 2) {
							assert.equal(input.malformedControl, "malformed");
							assert.match(input.validationError ?? "", /Chair/);
						}
						return "malformed";
					}
					return JSON.stringify(
						input.phase === "round"
							? { kind: "draft-recommendation" }
							: { kind: "finalize-recommendation" },
					);
				},
				respond({ phase, member }) {
					return `${phase} from ${member.handle}`;
				},
			},
		});

		assert.equal(attempts, 2);
		assert.deepEqual(session.deliberations[0]?.outcome, {
			kind: "incomplete-deliberation",
			reason: "chair-failure",
		});
		assert.equal(
			session.timeline.filter((entry) => entry.kind === "recommendation")
				.length,
			0,
		);
		assert.match(session.timeline.at(-1)?.content ?? "", /Chair/);
	}
});

test("rejects empty contributions and incomplete Recommendation content", async () => {
	const emptyPosition = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	await runDeliberation(emptyPosition, "Can empty output count?", {
		adapter: {
			selectParticipants() {
				return JSON.stringify({
					kind: "select-participants",
					members: ["researcher", "critic"],
				});
			},
			control: deterministicFakeAdapter.control,
			respond({ phase, member }) {
				return phase === "position" && member.handle === "critic"
					? ""
					: `${phase} from ${member.handle}`;
			},
		},
	});

	assert.deepEqual(emptyPosition.deliberations[0]?.outcome, {
		kind: "incomplete-deliberation",
		reason: "missing-quorum",
	});
	assert.match(
		emptyPosition.timeline.find((entry) => entry.kind === "member-failure")
			?.content ?? "",
		/content must be non-empty/,
	);

	const invalidRecommendation = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	await runDeliberation(invalidRecommendation, "Can a partial answer pass?", {
		adapter: {
			selectParticipants() {
				return JSON.stringify({
					kind: "select-participants",
					members: ["researcher", "critic"],
				});
			},
			control: deterministicFakeAdapter.control,
			respond({ phase, member }) {
				return phase === "recommendation"
					? "Ship it."
					: `${phase} from ${member.handle}`;
			},
		},
	});

	assert.deepEqual(invalidRecommendation.deliberations[0]?.outcome, {
		kind: "incomplete-deliberation",
		reason: "chair-failure",
	});
	assert.equal(
		invalidRecommendation.timeline.filter(
			(entry) => entry.kind === "recommendation",
		).length,
		0,
	);
	assert.match(
		invalidRecommendation.timeline.at(-1)?.content ?? "",
		/Recommendation must include a Synthesis section/,
	);
});

test("does not let a Recommendation drop research claims or Dissent", async () => {
	const omission = [
		"## Synthesis",
		"Ship it.",
		"## Reasoning",
		"The Council reviewed it.",
		"## Uncertainty",
		"Some uncertainty remains.",
		"## Sources",
		"No research claims.",
		"## Dissent",
		"No material Dissent.",
	].join("\n");
	for (const [kind, expectedError] of [
		["research", /Sources must include a concrete URL/],
		["dissent", /Dissent must include @critic's review/],
	] as const) {
		const session = createSession({
			council,
			workingDirectory: "/tmp/workspace",
			profileContents: {},
		});
		await runDeliberation(session, "Can evidence be omitted?", {
			adapter: {
				selectParticipants() {
					return JSON.stringify({
						kind: "select-participants",
						members: ["researcher", "critic"],
					});
				},
				control: deterministicFakeAdapter.control,
				respond({ phase, member }) {
					if (phase === "recommendation") return omission;
					if (phase === "position") {
						return kind === "research" && member.handle === "researcher"
							? "Conversion increased by 20%."
							: "No research claims.";
					}
					if (phase === "review") {
						return kind === "dissent" && member.handle === "critic"
							? "Do not ship before load testing."
							: "No material Dissent.";
					}
					return `${phase} from ${member.handle}`;
				},
			},
		});

		assert.deepEqual(session.deliberations[0]?.outcome, {
			kind: "incomplete-deliberation",
			reason: "chair-failure",
		});
		assert.equal(
			session.timeline.some((entry) => entry.kind === "recommendation"),
			false,
		);
		assert.match(session.timeline.at(-1)?.content ?? "", expectedError);
	}
});

test("repairs Session permissions and removes only the selected Session record", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "openagentcouncil-"));
	const session = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	await saveSession(directory, session);
	const sessions = path.join(directory, "sessions");
	const file = path.join(sessions, `${session.id}.json`);
	await chmod(sessions, 0o755);
	await chmod(file, 0o644);
	await writeFile(path.join(directory, "council.json"), "unchanged");

	assert.equal(
		(await loadSessionMetadata(directory))[0]?.latestQuestion,
		undefined,
	);
	assert.equal((await stat(sessions)).mode & 0o777, 0o700);
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	await removeSession(directory, session.id);

	assert.deepEqual(await readdir(sessions), []);
	assert.equal(
		await readFile(path.join(directory, "council.json"), "utf8"),
		"unchanged",
	);
	await rm(directory, { recursive: true, force: true });
});

test("reports unsupported Session schemas without altering their files", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "openagentcouncil-"));
	const sessions = path.join(directory, "sessions");
	const file = path.join(sessions, "future.json");
	await mkdir(sessions, { mode: 0o700 });
	await writeFile(file, '{"version":2}\n', { mode: 0o644 });
	const before = await readFile(file, "utf8");

	await assert.rejects(
		loadSessionMetadata(directory),
		/Unsupported Session schema version 2/,
	);

	assert.equal(await readFile(file, "utf8"), before);
	assert.equal((await stat(file)).mode & 0o777, 0o644);
	await rm(directory, { recursive: true, force: true });
});

test("rejects Session files whose record identity does not match their filename", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "openagentcouncil-"));
	const session = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	await saveSession(directory, session);
	await writeFile(
		path.join(directory, "sessions", "mismatched.json"),
		JSON.stringify(session),
	);

	await assert.rejects(
		loadSessionMetadata(directory),
		/Session file identity does not match its record/,
	);
	await rm(directory, { recursive: true, force: true });
});

test("refuses symlinked Session files without repairing their targets", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "openagentcouncil-"));
	const session = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	const target = path.join(directory, "outside.json");
	const file = path.join(directory, "sessions", `${session.id}.json`);
	await mkdir(path.join(directory, "sessions"), { mode: 0o700 });
	await writeFile(target, JSON.stringify(session), { mode: 0o644 });
	await symlink(target, file);

	await assert.rejects(
		loadSession(directory, session.id),
		/must be a regular file/,
	);
	assert.equal((await stat(target)).mode & 0o777, 0o644);
	await rm(directory, { recursive: true, force: true });
});

test("ignores an interrupted temporary Session record", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "openagentcouncil-"));
	const session = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	await saveSession(directory, session);
	await writeFile(
		path.join(directory, "sessions", `${session.id}.json.interrupted.tmp`),
		"{",
	);

	assert.equal((await loadSession(directory, session.id)).id, session.id);
	await rm(directory, { recursive: true, force: true });
});

test("loads legacy version 1 Sessions without provider references", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "openagentcouncil-"));
	const session = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {},
	});
	await runDeliberation(session, "Should we ship it?");
	await saveSession(directory, session);
	const file = path.join(directory, "sessions", `${session.id}.json`);
	const stored = JSON.parse(await readFile(file, "utf8")) as typeof session;
	for (const deliberation of stored.deliberations) {
		delete (deliberation as Partial<typeof deliberation>)
			.providerSessionReferences;
	}
	await writeFile(file, `${JSON.stringify(stored)}\n`);

	assert.deepEqual(
		(await loadSession(directory, session.id)).deliberations[0]
			?.providerSessionReferences,
		{},
	);
	await rm(directory, { recursive: true, force: true });
});

test("resumes a persisted Session snapshot and saves continued Deliberations", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "openagentcouncil-"));
	const session = createSession({
		council,
		workingDirectory: "/tmp/workspace",
		profileContents: {
			"chair.md": "Original Chair profile",
			"researcher.md": "Original Researcher profile",
			"critic.md": "Original Critic profile",
			"prototyper.md": "Original Prototyper profile",
		},
	});
	await runDeliberation(session, "Should we ship it?");
	const [deliberation] = session.deliberations;
	if (!deliberation) throw new Error("Deliberation fixture is required");
	deliberation.providerSessionReferences.researcher =
		"fixture-provider-session";
	await saveSession(directory, session);

	const resumed = await loadSession(directory, session.id);
	assert.deepEqual(
		resumed,
		JSON.parse(JSON.stringify(session)) as typeof session,
	);
	assert.equal(
		resumed.deliberations[0]?.providerSessionReferences.researcher,
		"fixture-provider-session",
	);
	await runDeliberation(resumed, "What should we do next?");
	await saveSession(directory, resumed);

	assert.equal(resumed.deliberations.length, 2);
	assert.equal(
		(await loadSession(directory, session.id)).timeline.at(-1)?.kind,
		"recommendation",
	);
	await rm(directory, { recursive: true, force: true });
});
