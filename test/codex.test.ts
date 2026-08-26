import assert from "node:assert/strict";
import {
	chmod,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexCouncilAdapter } from "../src/codex.js";
import {
	CouncilAdapterError,
	createSession,
	deterministicFakeAdapter,
	runDeliberation,
} from "../src/session.js";
import { validateConfiguration } from "../src/configuration.js";

const fixtureSource = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const directory = path.dirname(process.argv[1]);
const mode = readFileSync(path.join(directory, "mode"), "utf8").trim();
const log = (value) => appendFileSync(path.join(directory, "fixture.log"), JSON.stringify(value) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
log({ cwd: process.cwd(), argv: process.argv.slice(2), inherited: process.env.OPEN_AGENT_COUNCIL_FIXTURE });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
	log(JSON.parse(line));
	const message = JSON.parse(line);
	if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fixture" } });
	if (message.method === "thread/start" || message.method === "thread/resume") {
		const writable = message.params.sandbox === "workspace-write";
		send({ id: message.id, result: {
			thread: { id: "codex-thread-1" },
			cwd: process.cwd(),
			instructionSources: [mode === "personal" ? path.join(process.cwd(), "..", "AGENTS.md") : path.join(process.cwd(), "AGENTS.md")],
			approvalPolicy: "never",
			sandbox: { type: writable ? "workspaceWrite" : "readOnly", networkAccess: false, ...(writable ? { writableRoots: [process.cwd()] } : {}) }
		} });
	}
	if (message.method === "turn/start") {
		const policy = message.params.sandboxPolicy;
		const attempt = (allowed, action) => {
			if (!allowed) return "blocked";
			action();
			return "succeeded";
		};
		if (policy.type === "workspaceWrite") log({ boundaryAttempts: {
			write: attempt(true, () => writeFileSync(path.join(process.cwd(), "codex-assignment.txt"), "written without network")),
			network: attempt(policy.networkAccess === true, () => { throw new Error("network unexpectedly allowed"); })
		} });
		send({ id: message.id, result: { turn: { id: "turn-1" } } });
		if (mode === "malformed") return process.stdout.write("not json\\n");
		if (mode === "exit") {
			process.stderr.write("OPEN_AGENT_COUNCIL_SECRET");
			return process.exit(7);
		}
		if (mode === "hang" || mode === "ignore-term") return;
		const content = message.params.input[0].text.includes("Direct the next Council step") ? (mode === "assignment-control" ? '{"kind":"propose-assignment","member":"researcher","goal":"Create proof","expectedFiles":["proof.txt"]}' : '{"kind":"draft-recommendation"}') : "Fixture Position";
		send({ method: "item/agentMessage/delta", params: { threadId: "codex-thread-1", turnId: "turn-1", itemId: "item-1", delta: "Fixture" } });
		send({ method: "item/completed", params: { threadId: "codex-thread-1", turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: content, phase: "final_answer" } } });
		send({ method: "turn/completed", params: { threadId: "codex-thread-1", turn: { id: "turn-1", status: "completed", error: null } } });
	}
	if (message.method === "turn/interrupt") send({ id: message.id, result: {} });
});

process.on("SIGTERM", () => {
	log({ signal: "SIGTERM" });
	if (mode !== "ignore-term") process.exit(0);
});
`;

async function fixture(mode = "normal") {
	const directory = await mkdtemp(path.join(os.tmpdir(), "codex-app-server-"));
	const command = path.join(directory, "codex");
	await writeFile(command, fixtureSource);
	await chmod(command, 0o700);
	await writeFile(path.join(directory, "AGENTS.md"), "Repository instructions");
	await writeFile(path.join(directory, "mode"), mode);
	await writeFile(path.join(directory, "fixture.log"), "");
	return {
		command,
		directory,
		async messages() {
			return (await readFile(path.join(directory, "fixture.log"), "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		},
		remove: () => rm(directory, { recursive: true, force: true }),
	};
}

const member = {
	handle: "researcher",
	role: "Researcher",
	provider: "codex" as const,
	profile: "researcher.md",
	profileContent: "Check claims and cite evidence.",
	capabilities: ["web" as const],
};

const runtimeCouncil = validateConfiguration(
	{
		version: 1,
		councils: [
			{
				name: "Test Council",
				members: [
					{
						handle: "researcher",
						role: "Researcher",
						provider: "codex",
						profile: "researcher.md",
						capabilities: ["web"],
					},
					{
						handle: "chair",
						role: "Chair",
						provider: "codex",
						profile: "chair.md",
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
	},
	["codex"],
).councils[0];

if (!runtimeCouncil) throw new Error("Council fixture is required");

function runtimeSession(workingDirectory: string) {
	return createSession({
		council: runtimeCouncil,
		workingDirectory,
		profileContents: {
			"researcher.md": member.profileContent,
			"chair.md": "Chair profile",
			"critic.md": "Critic profile",
		},
	});
}

function runtimeAdapter(
	server: Awaited<ReturnType<typeof fixture>>,
	overrides: { timeoutMs?: number; terminationGraceMs?: number } = {},
) {
	return createCodexCouncilAdapter({
		command: server.command,
		workingDirectory: server.directory,
		fallback: {
			...deterministicFakeAdapter,
			selectParticipants: () =>
				JSON.stringify({
					kind: "select-participants",
					members: ["researcher", "critic"],
				}),
		},
		...overrides,
	});
}

test("runs a Codex Position with inherited auth environment and enforced boundaries", async () => {
	const server = await fixture();
	process.env.OPEN_AGENT_COUNCIL_FIXTURE = "inherited";
	const statuses: string[] = [];
	try {
		const adapter = createCodexCouncilAdapter({
			command: server.command,
			workingDirectory: server.directory,
		});
		const response = await adapter.respond({
			phase: "position",
			member,
			question: "Should we ship?",
			priorContent: [],
			workingDirectory: server.directory,
			onPartial: () => statuses.push("typing"),
		});

		assert.deepEqual(response, {
			content: "Fixture Position",
			providerSessionReference: "codex-thread-1",
			source: { provider: "codex", transport: "app-server" },
		});
		assert.deepEqual(statuses, ["typing"]);
		const messages = await server.messages();
		assert.deepEqual(messages[0], {
			cwd: await realpath(server.directory),
			argv: [
				"app-server",
				"--stdio",
				"--strict-config",
				"--disable",
				"hooks",
				"--disable",
				"plugins",
				"--disable",
				"apps",
				"--disable",
				"skill_search",
				"--disable",
				"multi_agent",
				"--disable",
				"browser_use",
				"--disable",
				"in_app_browser",
				"--disable",
				"computer_use",
				"--disable",
				"image_generation",
				"--disable",
				"memories",
				"-c",
				"mcp_servers={}",
			],
			inherited: "inherited",
		});
		const start = messages.find((message) => message.method === "thread/start");
		assert.deepEqual(start?.params, {
			cwd: server.directory,
			sandbox: "read-only",
			approvalPolicy: "never",
			config: {
				web_search: "live",
				tools: { web_search: {} },
				skills: {
					include_instructions: false,
					bundled: { enabled: false },
					config: [],
				},
				memories: {
					generate_memories: false,
					use_memories: false,
					dedicated_tools: false,
				},
			},
			developerInstructions: "Check claims and cite evidence.",
			personality: "none",
		});
		const turn = messages.find((message) => message.method === "turn/start");
		assert.deepEqual(turn?.params, {
			threadId: "codex-thread-1",
			input: [
				{
					type: "text",
					text: "Form your independent Position for this Council Deliberation. Return only the completed Position in Markdown.\n\nQuestion:\nShould we ship?",
					text_elements: [],
				},
			],
			cwd: server.directory,
			approvalPolicy: "never",
			sandboxPolicy: { type: "readOnly", networkAccess: false },
		});
	} finally {
		delete process.env.OPEN_AGENT_COUNCIL_FIXTURE;
		await server.remove();
	}
});

test("runs an approved Codex Assignment with repository writes and no network", async () => {
	const server = await fixture();
	try {
		await createCodexCouncilAdapter({
			command: server.command,
			workingDirectory: server.directory,
		}).respond({
			phase: "assignment",
			member,
			question: "Can we prove it?",
			priorContent: [],
			assignment: {
				member: member.handle,
				goal: "Create proof",
				expectedFiles: ["proof.txt"],
			},
			workingDirectory: server.directory,
			onPartial() {},
		});

		const messages = await server.messages();
		const start = messages.find((message) => message.method === "thread/start");
		const startParams = start?.params as Record<string, unknown>;
		assert.equal(startParams.sandbox, "workspace-write");
		assert.deepEqual(
			(startParams.config as Record<string, unknown>).web_search,
			"disabled",
		);
		const turn = messages.find((message) => message.method === "turn/start");
		const turnParams = turn?.params as Record<string, unknown>;
		assert.deepEqual(turnParams.sandboxPolicy, {
			type: "workspaceWrite",
			writableRoots: [server.directory],
			networkAccess: false,
		});
		assert.match(
			(turnParams.input as { text: string }[])?.[0]?.text ?? "",
			/Goal:\nCreate proof/,
		);
		assert.equal(
			await readFile(
				path.join(server.directory, "codex-assignment.txt"),
				"utf8",
			),
			"written without network",
		);
		assert.deepEqual(
			messages.find((message) => message.boundaryAttempts)?.boundaryAttempts,
			{ write: "succeeded", network: "blocked" },
		);
	} finally {
		await server.remove();
	}
});

test("lets the Codex Chair propose an Assignment through native control", async () => {
	const server = await fixture("assignment-control");
	try {
		const chair = { ...member, handle: "chair", role: "Chair" };
		const adapter = createCodexCouncilAdapter({
			command: server.command,
			workingDirectory: server.directory,
		});
		const request = {
			phase: "round" as const,
			chair,
			members: [chair, member],
			question: "Can we prove it?",
			round: 1,
			priorContent: [],
		};
		const control = await adapter.control(request);
		assert.notEqual(typeof control, "string");
		if (typeof control === "string") throw new Error("Expected Codex response");
		assert.deepEqual(JSON.parse(control.content), {
			kind: "propose-assignment",
			member: "researcher",
			goal: "Create proof",
			expectedFiles: ["proof.txt"],
		});
		await adapter.control({
			...request,
			round: 2,
			providerSessionReference: control.providerSessionReference,
		});
		assert.ok(
			(await server.messages()).some(
				(message) => message.method === "thread/resume",
			),
		);
	} finally {
		await server.remove();
	}
});

test("resumes the provider-native Codex thread", async () => {
	const server = await fixture();
	try {
		const adapter = createCodexCouncilAdapter({
			command: server.command,
			workingDirectory: server.directory,
		});
		await adapter.respond({
			phase: "review",
			member: { ...member, capabilities: undefined },
			question: "Should we ship?",
			priorContent: ["Draft Recommendation"],
			workingDirectory: server.directory,
			providerSessionReference: "codex-thread-1",
			onPartial() {},
		});

		const messages = await server.messages();
		assert.equal(
			messages.some((message) => message.method === "thread/start"),
			false,
		);
		assert.deepEqual(
			messages.find((message) => message.method === "thread/resume")?.params,
			{
				threadId: "codex-thread-1",
				cwd: server.directory,
				sandbox: "read-only",
				approvalPolicy: "never",
				config: {
					web_search: "disabled",
					skills: {
						include_instructions: false,
						bundled: { enabled: false },
						config: [],
					},
					memories: {
						generate_memories: false,
						use_memories: false,
						dedicated_tools: false,
					},
				},
				developerInstructions: "Check claims and cite evidence.",
				personality: "none",
			},
		);
	} finally {
		await server.remove();
	}
});

test("fails when Codex reports a personal instruction source", async () => {
	const server = await fixture("personal");
	try {
		const adapter = createCodexCouncilAdapter({
			command: server.command,
			workingDirectory: server.directory,
		});
		await assert.rejects(
			Promise.resolve(
				adapter.respond({
					phase: "position",
					member,
					question: "Should we ship?",
					priorContent: [],
					workingDirectory: server.directory,
					onPartial() {},
				}),
			),
			/personal instruction source/,
		);
	} finally {
		await server.remove();
	}
});

for (const [mode, pattern] of [
	["malformed", /malformed App Server message/],
	["exit", /App Server exited with code 7/],
] as const) {
	test(`reports ${mode} App Server failure clearly`, async () => {
		const server = await fixture(mode);
		try {
			const adapter = createCodexCouncilAdapter({
				command: server.command,
				workingDirectory: server.directory,
			});
			await assert.rejects(
				Promise.resolve(
					adapter.respond({
						phase: "position",
						member,
						question: "Should we ship?",
						priorContent: [],
						workingDirectory: server.directory,
						onPartial() {},
					}),
				),
				(error: Error) =>
					pattern.test(error.message) &&
					!error.message.includes("OPEN_AGENT_COUNCIL_SECRET"),
			);
		} finally {
			await server.remove();
		}
	});
}

test("interrupts, terminates, and force-kills an unresponsive App Server", async () => {
	for (const mode of ["hang", "ignore-term"]) {
		const server = await fixture(mode);
		try {
			const controller = new AbortController();
			const adapter = createCodexCouncilAdapter({
				command: server.command,
				workingDirectory: server.directory,
				timeoutMs: 10_000,
				terminationGraceMs: 50,
			});
			const response = Promise.resolve(
				adapter.respond({
					phase: "position",
					member,
					question: "Should we ship?",
					priorContent: [],
					workingDirectory: server.directory,
					signal: controller.signal,
					onPartial() {},
				}),
			);
			await new Promise((resolve) => setTimeout(resolve, 150));
			controller.abort();
			await assert.rejects(
				response,
				(error: Error) =>
					error instanceof CouncilAdapterError &&
					error.outcome === "cancelled" &&
					error.source.transport === "app-server" &&
					/abort/i.test(error.message),
			);
			assert.ok(
				(await server.messages()).some(
					(message) => message.method === "turn/interrupt",
				),
			);
		} finally {
			await server.remove();
		}
	}
});

test("times out an unresponsive App Server", async () => {
	const server = await fixture("hang");
	try {
		const adapter = createCodexCouncilAdapter({
			command: server.command,
			workingDirectory: server.directory,
			timeoutMs: 100,
			terminationGraceMs: 25,
		});
		await assert.rejects(
			Promise.resolve(
				adapter.respond({
					phase: "position",
					member,
					question: "Should we ship?",
					priorContent: [],
					workingDirectory: server.directory,
					onPartial() {},
				}),
			),
			(error: Error) =>
				error instanceof CouncilAdapterError &&
				error.outcome === "timed-out" &&
				/timed out/.test(error.message),
		);
	} finally {
		await server.remove();
	}
});

test("normalizes App Server failures with source metadata", async () => {
	const server = await fixture("hang");
	try {
		const session = runtimeSession(server.directory);
		const events = await runDeliberation(session, "Should we ship?", {
			adapter: runtimeAdapter(server, {
				timeoutMs: 500,
				terminationGraceMs: 25,
			}),
		});
		const outcome = events.find(
			(event) =>
				event.kind === "provider-outcome" && event.member === "researcher",
		);
		assert.deepEqual(
			outcome?.kind === "provider-outcome"
				? { outcome: outcome.outcome, source: outcome.source }
				: undefined,
			{
				outcome: "timed-out",
				source: {
					provider: "codex",
					transport: "app-server",
					nativeReference: "codex-thread-1",
				},
			},
		);
	} finally {
		await server.remove();
	}
});

test("runs one Codex Council Member alongside fixture-backed Members", async () => {
	const server = await fixture();
	try {
		const session = runtimeSession(server.directory);

		const events = await runDeliberation(session, "Should we ship?", {
			adapter: runtimeAdapter(server),
		});
		const position = session.timeline.find(
			(entry) => entry.kind === "position" && entry.member === "researcher",
		);
		assert.equal(position?.content, "Fixture Position");
		assert.deepEqual(
			position?.kind === "position" ? position.source : undefined,
			{
				provider: "codex",
				transport: "app-server",
				nativeReference: "codex-thread-1",
			},
		);
		assert.equal(
			session.deliberations[0]?.providerSessionReferences.researcher,
			"codex-thread-1",
		);
		assert.equal(
			events.filter(
				(event) => event.kind === "content" && event.entry.kind === "position",
			).length,
			2,
		);
	} finally {
		await server.remove();
	}
});
