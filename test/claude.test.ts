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
import { createClaudeCouncilAdapter } from "../src/claude.js";
import { validateConfiguration } from "../src/configuration.js";
import {
	CouncilAdapterError,
	createSession,
	deterministicFakeAdapter,
	runDeliberation,
} from "../src/session.js";

const fixtureSource = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const directory = path.dirname(process.argv[1]);
const mode = readFileSync(path.join(directory, "mode"), "utf8").trim();
const log = (value) => appendFileSync(path.join(directory, "fixture.log"), JSON.stringify(value) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const sessionId = valueAfter("--resume") ?? "11111111-1111-4111-8111-111111111111";
const tools = (valueAfter("--tools") ?? "").split(",").filter(Boolean);
const attemptTool = (name, action) => {
  if (!tools.includes(name)) return "blocked";
  action();
  return "succeeded";
};
if (tools.includes("Write")) log({ boundaryAttempts: {
  write: attemptTool("Write", () => writeFileSync(path.join(process.cwd(), "claude-assignment.txt"), "written without web tools")),
  network: attemptTool("WebFetch", () => { throw new Error("network unexpectedly allowed"); })
} });
log({
  cwd: process.cwd(),
  argv: args,
  inherited: process.env.OPEN_AGENT_COUNCIL_FIXTURE,
  disableClaudeMds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS,
  simple: process.env.CLAUDE_CODE_SIMPLE,
  safeMode: process.env.CLAUDE_CODE_SAFE_MODE,
  disableAutoMemory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
});

send({
  type: "system",
  subtype: "init",
  cwd: process.cwd(),
  session_id: sessionId,
  tools: mode === "bad-tools" ? [...tools, "Write"] : tools,
  mcp_servers: [],
  slash_commands: [],
  skills: mode === "bad-skills" ? ["fixture-skill"] : [],
  plugins: []
});
if (mode === "malformed") {
  process.stdout.write("not json\\n");
  setInterval(() => {}, 1_000);
} else if (mode === "exit") {
  process.stderr.write("fixture failed");
  process.exit(7);
} else if (mode === "hang" || mode === "ignore-term") {
  setInterval(() => {}, 1_000);
} else if (mode === "failure") {
  send({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId, result: "fixture rejected" });
} else {
	const content = args.at(-1).includes("Direct the next Council step") ? (mode === "assignment-control" ? '{"kind":"propose-assignment","member":"researcher","goal":"Create proof","expectedFiles":["proof.txt"]}' : '{"kind":"draft-recommendation"}') : "Fixture Position";
	send({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "Fixture" } }
  });
	  send({ type: "result", subtype: "success", is_error: false, session_id: sessionId, result: content });
}

process.on("SIGTERM", () => {
  log({ signal: "SIGTERM" });
  if (mode !== "ignore-term") process.exit(0);
});
`;

async function fixture(mode = "normal") {
	const directory = await mkdtemp(path.join(os.tmpdir(), "claude-print-mode-"));
	const command = path.join(directory, "claude");
	await writeFile(command, fixtureSource);
	await chmod(command, 0o700);
	await writeFile(path.join(directory, "CLAUDE.md"), "Repository instructions");
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
	provider: "claude" as const,
	profile: "researcher.md",
	profileContent: "Check claims and cite evidence.",
	capabilities: ["web" as const],
};

test("runs a Claude Position with inherited auth environment and enforced boundaries", async () => {
	const server = await fixture();
	const originalEnvironment = {
		disableClaudeMds: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS,
		simple: process.env.CLAUDE_CODE_SIMPLE,
		safeMode: process.env.CLAUDE_CODE_SAFE_MODE,
		disableAutoMemory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
	};
	process.env.OPEN_AGENT_COUNCIL_FIXTURE = "inherited";
	process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
	process.env.CLAUDE_CODE_SIMPLE = "1";
	process.env.CLAUDE_CODE_SAFE_MODE = "1";
	process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "0";
	const statuses: string[] = [];
	try {
		const response = await createClaudeCouncilAdapter({
			command: server.command,
			workingDirectory: server.directory,
		}).respond({
			phase: "position",
			member,
			question: "Should we ship?",
			priorContent: [],
			workingDirectory: server.directory,
			onPartial: () => statuses.push("typing"),
		});

		assert.deepEqual(response, {
			content: "Fixture Position",
			providerSessionReference: "11111111-1111-4111-8111-111111111111",
			source: { provider: "claude", transport: "print-mode" },
		});
		assert.deepEqual(statuses, ["typing"]);
		const invocation = (await server.messages()).find(
			(message) => message.argv,
		);
		assert.equal(invocation?.cwd, await realpath(server.directory));
		assert.equal(invocation?.inherited, "inherited");
		assert.equal(invocation?.disableClaudeMds, undefined);
		assert.equal(invocation?.simple, undefined);
		assert.equal(invocation?.safeMode, undefined);
		assert.equal(invocation?.disableAutoMemory, "1");
		assert.deepEqual(invocation?.argv, [
			"--print",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--setting-sources",
			"project",
			"--settings",
			'{"disableAllHooks":true,"autoMemoryEnabled":false,"enabledPlugins":{}}',
			"--strict-mcp-config",
			"--mcp-config",
			'{"mcpServers":{}}',
			"--disable-slash-commands",
			"--no-chrome",
			"--disallowedTools",
			"mcp__*",
			"--permission-mode",
			"dontAsk",
			"--tools",
			"Read,Glob,Grep,WebSearch,WebFetch",
			"--append-system-prompt",
			"Check claims and cite evidence.",
			"Form your independent Position for this Council Deliberation. Return only the completed Position in Markdown.\n\nQuestion:\nShould we ship?",
		]);
	} finally {
		delete process.env.OPEN_AGENT_COUNCIL_FIXTURE;
		for (const [name, value] of [
			["CLAUDE_CODE_DISABLE_CLAUDE_MDS", originalEnvironment.disableClaudeMds],
			["CLAUDE_CODE_SIMPLE", originalEnvironment.simple],
			["CLAUDE_CODE_SAFE_MODE", originalEnvironment.safeMode],
			[
				"CLAUDE_CODE_DISABLE_AUTO_MEMORY",
				originalEnvironment.disableAutoMemory,
			],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await server.remove();
	}
});

test("runs an approved Claude Assignment with write tools and no web tools", async () => {
	const server = await fixture();
	try {
		await createClaudeCouncilAdapter({
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

		const invocation = (await server.messages()).find(
			(message) => message.argv,
		);
		const argv = invocation?.argv as string[];
		assert.equal(
			argv[argv.indexOf("--tools") + 1],
			"Read,Glob,Grep,Edit,Write",
		);
		assert.equal(argv[argv.indexOf("--permission-mode") + 1], "acceptEdits");
		assert.doesNotMatch(argv.join(" "), /WebSearch|WebFetch/);
		assert.match(argv.at(-1) ?? "", /Goal:\nCreate proof/);
		assert.equal(
			await readFile(
				path.join(server.directory, "claude-assignment.txt"),
				"utf8",
			),
			"written without web tools",
		);
		assert.deepEqual(
			(await server.messages()).find((message) => message.boundaryAttempts)
				?.boundaryAttempts,
			{ write: "succeeded", network: "blocked" },
		);
	} finally {
		await server.remove();
	}
});

test("lets the Claude Chair propose an Assignment through native control", async () => {
	const server = await fixture("assignment-control");
	try {
		const chair = { ...member, handle: "chair", role: "Chair" };
		const adapter = createClaudeCouncilAdapter({
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
		if (typeof control === "string")
			throw new Error("Expected Claude response");
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
			(await server.messages()).some((invocation) =>
				(invocation.argv as string[])?.includes("--resume"),
			),
		);
	} finally {
		await server.remove();
	}
});

test("selects one Claude Member from each Council without leaking across Sessions", async () => {
	const server = await fixture();
	try {
		const adapter = createClaudeCouncilAdapter({
			command: server.command,
			workingDirectory: server.directory,
		});
		const chair = {
			...member,
			handle: "chair",
			role: "Chair",
			capabilities: undefined,
		};
		await adapter.selectParticipants({
			chair,
			members: [chair, member],
			question: "First Session",
			requestedMembers: [],
		});
		await adapter.respond({
			phase: "position",
			member,
			question: "First Session",
			priorContent: [],
			workingDirectory: server.directory,
			onPartial() {},
		});

		const analyst = { ...member, handle: "analyst" };
		await adapter.selectParticipants({
			chair,
			members: [chair, member, analyst],
			question: "Second Session",
			requestedMembers: [],
		});
		const response = await adapter.respond({
			phase: "position",
			member: analyst,
			question: "Second Session",
			priorContent: [],
			workingDirectory: server.directory,
			onPartial() {},
		});

		assert.equal(
			typeof response === "string" ? response : response.content,
			"Fixture Position",
		);
		assert.equal((await server.messages()).length, 2);
	} finally {
		await server.remove();
	}
});

test("resumes the native Claude session with read-only non-web tools", async () => {
	const server = await fixture();
	try {
		const response = await createClaudeCouncilAdapter({
			command: server.command,
			workingDirectory: server.directory,
		}).respond({
			phase: "review",
			member: {
				...member,
				capabilities: undefined,
				model: "claude-sonnet-5",
				reasoningEffort: "high",
			},
			question: "Should we ship?",
			priorContent: ["Draft Recommendation"],
			workingDirectory: server.directory,
			providerSessionReference: "22222222-2222-4222-8222-222222222222",
			onPartial() {},
		});

		assert.equal(
			typeof response === "string"
				? undefined
				: response.providerSessionReference,
			"22222222-2222-4222-8222-222222222222",
		);
		const [invocation] = await server.messages();
		const argv = invocation?.argv as string[];
		assert.equal(argv[argv.indexOf("--tools") + 1], "Read,Glob,Grep");
		assert.equal(argv[argv.indexOf("--model") + 1], "claude-sonnet-5");
		assert.equal(argv[argv.indexOf("--effort") + 1], "high");
		assert.equal(
			argv[argv.indexOf("--resume") + 1],
			"22222222-2222-4222-8222-222222222222",
		);
		assert.match(argv.at(-1) ?? "", /Draft Recommendation/);
	} finally {
		await server.remove();
	}
});

for (const [mode, pattern] of [
	["malformed", /malformed structured output/],
	["exit", /exited with code 7: fixture failed/],
	["failure", /Claude Code failed: fixture rejected/],
	["bad-tools", /requested tool boundaries/],
	["bad-skills", /skills/],
] as const) {
	test(`reports ${mode} Claude print-mode failure clearly`, async () => {
		const server = await fixture(mode);
		try {
			await assert.rejects(
				Promise.resolve(
					createClaudeCouncilAdapter({
						command: server.command,
						workingDirectory: server.directory,
						terminationGraceMs: 25,
					}).respond({
						phase: "position",
						member,
						question: "Should we ship?",
						priorContent: [],
						workingDirectory: server.directory,
						onPartial() {},
					}),
				),
				pattern,
			);
		} finally {
			await server.remove();
		}
	});
}

test("cancels and force-terminates unresponsive Claude processes", async () => {
	for (const mode of ["hang", "ignore-term"]) {
		const server = await fixture(mode);
		try {
			const controller = new AbortController();
			const response = Promise.resolve(
				createClaudeCouncilAdapter({
					command: server.command,
					workingDirectory: server.directory,
					timeoutMs: 10_000,
					terminationGraceMs: 50,
				}).respond({
					phase: "position",
					member,
					question: "Should we ship?",
					priorContent: [],
					workingDirectory: server.directory,
					signal: controller.signal,
					onPartial() {},
				}),
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			controller.abort();
			await assert.rejects(
				response,
				(error: Error) =>
					error instanceof CouncilAdapterError &&
					error.outcome === "cancelled" &&
					error.source.provider === "claude" &&
					error.source.transport === "print-mode",
			);
			assert.ok(
				(await server.messages()).some(
					(message) => message.signal === "SIGTERM",
				),
			);
		} finally {
			await server.remove();
		}
	}
});

test("times out an unresponsive Claude process", async () => {
	const server = await fixture("hang");
	try {
		await assert.rejects(
			Promise.resolve(
				createClaudeCouncilAdapter({
					command: server.command,
					workingDirectory: server.directory,
					timeoutMs: 100,
					terminationGraceMs: 25,
				}).respond({
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

test("runs one Claude Council Member alongside fixture-backed Members", async () => {
	const server = await fixture();
	const council = validateConfiguration(
		{
			version: 1,
			councils: [
				{
					name: "Test Council",
					members: [
						{
							handle: "researcher",
							role: "Researcher",
							provider: "claude",
							profile: "researcher.md",
						},
						{
							handle: "chair",
							role: "Chair",
							provider: "claude",
							profile: "chair.md",
						},
						{
							handle: "critic",
							role: "Critic",
							provider: "claude",
							profile: "critic.md",
						},
					],
				},
			],
		},
		["claude"],
	).councils[0];
	if (!council) throw new Error("Council fixture is required");
	try {
		const session = createSession({
			council,
			workingDirectory: server.directory,
			profileContents: {
				"researcher.md": member.profileContent,
				"chair.md": "Chair profile",
				"critic.md": "Critic profile",
			},
		});
		const events = await runDeliberation(session, "Should we ship?", {
			adapter: createClaudeCouncilAdapter({
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
			}),
		});

		const position = session.timeline.find(
			(entry) => entry.kind === "position" && entry.member === "researcher",
		);
		assert.equal(position?.content, "Fixture Position");
		assert.deepEqual(
			position?.kind === "position" ? position.source : undefined,
			{
				provider: "claude",
				transport: "print-mode",
				nativeReference: "11111111-1111-4111-8111-111111111111",
			},
		);
		assert.equal(
			session.deliberations[0]?.providerSessionReferences.researcher,
			"11111111-1111-4111-8111-111111111111",
		);
		assert.ok(
			events.some(
				(event) =>
					event.kind === "member-status" &&
					event.member === "researcher" &&
					event.status === "typing",
			),
		);
		assert.equal(
			events.filter(
				(event) => event.kind === "content" && event.entry.kind === "position",
			).length,
			2,
		);
		assert.equal(
			session.timeline.some(
				(entry) => "content" in entry && entry.content === "Fixture",
			),
			false,
		);
		const invocations = await server.messages();
		assert.ok(
			invocations.some(
				(invocation) =>
					Array.isArray(invocation.argv) &&
					invocation.argv.includes("--resume"),
			),
		);
	} finally {
		await server.remove();
	}
});
