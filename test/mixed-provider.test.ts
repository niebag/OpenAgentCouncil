import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeCouncilAdapter } from "../src/claude.js";
import { createCodexCouncilAdapter } from "../src/codex.js";
import { validateConfiguration } from "../src/configuration.js";
import {
	createSession,
	deterministicFakeAdapter,
	runDeliberation,
} from "../src/session.js";

const fixtureSource = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const directory = path.dirname(process.argv[1]);
const provider = path.basename(process.argv[1]);
const mode = readFileSync(path.join(directory, provider + "-mode"), "utf8").trim();
const log = (value) => appendFileSync(path.join(directory, provider + ".log"), JSON.stringify(value) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const content = (prompt) => {
	if (prompt.includes("Finalize the reviewed Recommendation")) return '{"kind":"finalize-recommendation"}';
	if (prompt.includes("Direct the next Council step")) return '{"kind":"draft-recommendation"}';
	if (prompt.includes("independent Position")) return provider + " Position. No research claims.";
	if (prompt.includes("Review the Draft Recommendation")) return provider + " Review. No material Dissent.";
	if (prompt.includes("Council recommendation")) return "## Synthesis\\nShip.\\n## Reasoning\\nMixed Positions and reviews support it.\\n## Uncertainty\\nProduction remains unknown.\\n## Sources\\nNo research claims.\\n## Dissent\\nNo material Dissent.";
	return provider + " contribution";
};
const finish = (prompt, done) => {
	if (!prompt.includes("independent Position")) return done(content(prompt));
	writeFileSync(path.join(directory, provider + ".ready"), "ready");
	const barrier = setInterval(() => {
		if (!existsSync(path.join(directory, "codex.ready")) || !existsSync(path.join(directory, "claude.ready"))) return;
		clearInterval(barrier);
		done(content(prompt));
	}, 5);
};
const hang = () => {
	writeFileSync(path.join(directory, provider + ".ready"), "ready");
	const worker = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
	appendFileSync(path.join(directory, provider + ".pid"), process.pid + "\\n" + worker.pid + "\\n");
	setInterval(() => {}, 1_000);
};
process.on("SIGTERM", () => {
	log({ signal: "SIGTERM" });
	if (mode !== "ignore-term") process.exit(0);
});

if (provider === "codex") {
	let member = "";
	readline.createInterface({ input: process.stdin }).on("line", (line) => {
		const message = JSON.parse(line);
		if (message.method === "initialize") send({ id: message.id, result: {} });
		if (message.method === "thread/start" || message.method === "thread/resume") {
			member = message.params.developerInstructions;
			send({ id: message.id, result: {
			thread: { id: "codex-thread-" + process.pid }, cwd: process.cwd(), instructionSources: [path.join(directory, "AGENTS.md")],
			approvalPolicy: "never", sandbox: { type: "readOnly", networkAccess: false }
		} });
		}
		if (message.method === "turn/start") {
			send({ id: message.id, result: { turn: { id: "codex-turn" } } });
			const prompt = message.params.input[0].text;
			if (mode === "ignore-term" && member !== "prototyper" && prompt.includes("independent Position")) return hang();
			if (mode === "fail" && member === "critic" && prompt.includes("independent Position")) {
				writeFileSync(path.join(directory, provider + ".ready"), "ready");
				return send({ method: "turn/completed", params: { turn: { status: "failed", error: { message: "OPEN_AGENT_COUNCIL_SECRET" } } } });
			}
			finish(prompt, (value) => {
				send({ method: "item/agentMessage/delta", params: { delta: "OPEN_AGENT_COUNCIL_SECRET" } });
				send({ method: "item/completed", params: { item: { type: "agentMessage", phase: "final_answer", text: value } } });
				send({ method: "turn/completed", params: { turn: { status: "completed" } } });
			});
		}
		if (message.method === "turn/interrupt") send({ id: message.id, result: {} });
	});
} else {
	const args = process.argv.slice(2);
	const prompt = args.at(-1);
	const member = args[args.indexOf("--append-system-prompt") + 1];
	const tools = (args[args.indexOf("--tools") + 1] ?? "").split(",").filter(Boolean);
	send({ type: "system", subtype: "init", cwd: process.cwd(), session_id: "11111111-1111-4111-8111-111111111111", tools, mcp_servers: [], slash_commands: [], skills: [], plugins: [] });
	if (mode === "ignore-term" && prompt.includes("independent Position")) hang();
	else if (mode === "fail" && prompt.includes("independent Position")) {
		writeFileSync(path.join(directory, provider + ".ready"), "ready");
		send({ type: "result", subtype: "error", is_error: true, result: "OPEN_AGENT_COUNCIL_SECRET" });
	}
	else finish(prompt, (value) => {
		send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "OPEN_AGENT_COUNCIL_SECRET" } } });
		send({ type: "result", subtype: "success", is_error: false, session_id: "11111111-1111-4111-8111-111111111111", result: value });
	});
}
`;

async function fixture() {
	const directory = await mkdtemp(path.join(os.tmpdir(), "mixed-council-"));
	for (const provider of ["codex", "claude"]) {
		await writeFile(path.join(directory, provider), fixtureSource);
		await chmod(path.join(directory, provider), 0o700);
		await writeFile(path.join(directory, `${provider}-mode`), "normal");
		await writeFile(path.join(directory, `${provider}.log`), "");
	}
	await writeFile(path.join(directory, "AGENTS.md"), "Repository instructions");
	await writeFile(path.join(directory, "CLAUDE.md"), "Repository instructions");
	return directory;
}

const council = validateConfiguration(
	{
		version: 1,
		councils: [
			{
				name: "Mixed Council",
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
						provider: "claude",
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
	["codex", "claude"],
).councils[0];
if (!council) throw new Error("Mixed Council fixture is required");

function runtime(directory: string) {
	const fallback = {
		...deterministicFakeAdapter,
		selectParticipants: () =>
			JSON.stringify({
				kind: "select-participants",
				members: ["researcher", "critic", "prototyper"],
			}),
	};
	return createClaudeCouncilAdapter({
		command: path.join(directory, "claude"),
		workingDirectory: directory,
		terminationGraceMs: 25,
		fallback: createCodexCouncilAdapter({
			command: path.join(directory, "codex"),
			workingDirectory: directory,
			terminationGraceMs: 25,
			fallback,
		}),
	});
}

function session(directory: string) {
	return createSession({
		council,
		workingDirectory: directory,
		profileContents: {
			"chair.md": "chair",
			"researcher.md": "researcher",
			"critic.md": "critic",
			"prototyper.md": "prototyper",
		},
	});
}

test("completes a reviewed mixed-provider Recommendation concurrently and atomically", async () => {
	const directory = await fixture();
	try {
		const state = session(directory);
		const events = await runDeliberation(state, "Should we ship?", {
			adapter: runtime(directory),
		});
		assert.deepEqual(state.deliberations[0]?.outcome, {
			kind: "recommendation",
		});
		assert.deepEqual(
			state.timeline
				.flatMap((entry) =>
					entry.kind === "position" && entry.source
						? [entry.source.provider]
						: [],
				)
				.sort(),
			["claude", "codex", "codex"],
		);
		assert.equal(
			events.filter(
				(event) =>
					event.kind === "content" && event.entry.kind === "recommendation",
			).length,
			1,
		);
		assert.doesNotMatch(JSON.stringify(state), /OPEN_AGENT_COUNCIL_SECRET/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("keeps mixed-provider Quorum after one normalized provider failure", async () => {
	const directory = await fixture();
	try {
		await writeFile(path.join(directory, "codex-mode"), "fail");
		const state = session(directory);
		const events = await runDeliberation(state, "Should we ship?", {
			adapter: runtime(directory),
		});
		assert.deepEqual(state.deliberations[0]?.outcome, {
			kind: "recommendation",
		});
		assert.ok(
			state.timeline.some(
				(entry) => entry.kind === "position" && entry.member === "researcher",
			),
		);
		assert.ok(
			state.timeline.some(
				(entry) => entry.kind === "position" && entry.member === "prototyper",
			),
		);
		assert.ok(
			events.some(
				(event) =>
					event.kind === "provider-outcome" &&
					event.member === "critic" &&
					event.outcome === "failed",
			),
		);
		assert.doesNotMatch(
			JSON.stringify({ state, events }),
			/OPEN_AGENT_COUNCIL_SECRET/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("stops both mixed providers, force-kills holdouts, and preserves completed work", async () => {
	const directory = await fixture();
	try {
		await Promise.all([
			writeFile(path.join(directory, "codex-mode"), "ignore-term"),
			writeFile(path.join(directory, "claude-mode"), "ignore-term"),
		]);
		const state = session(directory);
		const controller = new AbortController();
		const result = runDeliberation(state, "Should we stop?", {
			adapter: runtime(directory),
			signal: controller.signal,
		});
		while (
			!(
				await Promise.all(
					["codex", "claude"].map(async (provider) =>
						readFile(path.join(directory, `${provider}.pid`), "utf8").then(
							() => true,
							() => false,
						),
					),
				)
			).every(Boolean) ||
			!state.timeline.some(
				(entry) => entry.kind === "position" && entry.member === "prototyper",
			)
		)
			await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		await result;

		assert.deepEqual(state.deliberations[0]?.outcome, {
			kind: "incomplete-deliberation",
			reason: "cancelled",
		});
		assert.ok(
			state.timeline.some(
				(entry) => entry.kind === "position" && entry.member === "prototyper",
			),
		);
		for (const provider of ["codex", "claude"]) {
			assert.match(
				await readFile(path.join(directory, `${provider}.log`), "utf8"),
				/SIGTERM/,
			);
			const pids = (
				await readFile(path.join(directory, `${provider}.pid`), "utf8")
			)
				.trim()
				.split("\n")
				.map(Number);
			assert.ok(pids.length >= 2);
			for (const pid of pids) assert.throws(() => process.kill(pid, 0));
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
