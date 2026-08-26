import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {
	deterministicFakeAdapter,
	CouncilAdapterError,
	councilPrompt,
	type CouncilAdapter,
	type CouncilRequest,
	type CouncilResponse,
} from "./session.js";

type Options = {
	workingDirectory: string;
	command?: string;
	fallback?: CouncilAdapter;
	timeoutMs?: number;
	terminationGraceMs?: number;
};

type ClaudeMessage = {
	type?: string;
	subtype?: string;
	is_error?: boolean;
	session_id?: string;
	result?: string;
	cwd?: string;
	tools?: unknown[];
	mcp_servers?: unknown[];
	slash_commands?: unknown[];
	skills?: unknown[];
	plugins?: unknown[];
	event?: {
		type?: string;
		delta?: { type?: string; text?: string };
	};
};

const settings = JSON.stringify({
	disableAllHooks: true,
	autoMemoryEnabled: false,
	enabledPlugins: {},
});
const mcpConfiguration = JSON.stringify({ mcpServers: {} });

function wait(milliseconds: number) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function terminate(
	child: ChildProcessWithoutNullStreams,
	exited: Promise<void>,
	grace: number,
) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	if (
		await Promise.race([exited.then(() => true), wait(grace).then(() => false)])
	)
		return;
	child.kill("SIGKILL");
	await exited;
}

function expectedTools(request: CouncilRequest) {
	return [
		"Read",
		"Glob",
		"Grep",
		...(request.member.capabilities?.includes("web")
			? ["WebSearch", "WebFetch"]
			: []),
	];
}

async function assertBoundaries(
	message: ClaudeMessage,
	request: CouncilRequest,
) {
	const repositoryDirectory = await realpath(request.workingDirectory);
	const reportedDirectory = await realpath(String(message.cwd)).catch(() => "");
	if (reportedDirectory !== repositoryDirectory) {
		throw new Error(
			`Claude Code did not preserve the repository directory (received ${String(message.cwd)})`,
		);
	}
	if (!Array.isArray(message.tools)) {
		throw new Error("Claude Code did not report its available tools");
	}
	const tools = expectedTools(request);
	const allowedTools = new Set([...tools, "EndConversation"]);
	if (
		tools.some((tool) => !message.tools?.includes(tool)) ||
		message.tools.some(
			(tool) => typeof tool !== "string" || !allowedTools.has(tool),
		)
	) {
		throw new Error(
			"Claude Code did not enforce the requested tool boundaries",
		);
	}
	for (const [name, value] of [
		["MCP servers", message.mcp_servers],
		["commands", message.slash_commands],
		["skills", message.skills],
		["plugins", message.plugins],
	] as const) {
		if (!Array.isArray(value) || value.length > 0) {
			throw new Error(`Claude Code did not disable ${name}`);
		}
	}
}

async function runClaude(
	request: CouncilRequest,
	options: Required<
		Pick<Options, "command" | "timeoutMs" | "terminationGraceMs">
	>,
): Promise<CouncilResponse> {
	request.signal?.throwIfAborted();
	const tools = expectedTools(request);
	const arguments_ = [
		"--print",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--setting-sources",
		"project",
		"--settings",
		settings,
		"--strict-mcp-config",
		"--mcp-config",
		mcpConfiguration,
		"--disable-slash-commands",
		"--no-chrome",
		"--disallowedTools",
		"mcp__*",
		"--permission-mode",
		"dontAsk",
		"--tools",
		tools.join(","),
		"--append-system-prompt",
		request.member.profileContent,
		...(request.member.model ? ["--model", request.member.model] : []),
		...(request.member.reasoningEffort
			? ["--effort", request.member.reasoningEffort]
			: []),
		...(request.providerSessionReference
			? ["--resume", request.providerSessionReference]
			: []),
		councilPrompt(request),
	];
	const environment = { ...process.env };
	delete environment.CLAUDE_CODE_DISABLE_CLAUDE_MDS;
	delete environment.CLAUDE_CODE_SIMPLE;
	delete environment.CLAUDE_CODE_SAFE_MODE;
	environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
	const child = spawn(options.command, arguments_, {
		cwd: request.workingDirectory,
		env: environment,
		stdio: "pipe",
	});
	child.stdin.end();
	let stderr = "";
	let sessionId: string | undefined;
	let result: ClaudeMessage | undefined;
	let init: ClaudeMessage | undefined;
	let fatalReject: (error: Error) => void = () => {};
	const fatal = new Promise<never>((_, reject) => {
		fatalReject = reject;
	});
	let exitResolve: () => void = () => {};
	const exited = new Promise<void>((resolve) => {
		exitResolve = resolve;
	});
	let processResolve: (value: {
		code: number | null;
		signal: string | null;
	}) => void = () => {};
	const processExit = new Promise<{
		code: number | null;
		signal: string | null;
	}>((resolve) => {
		processResolve = resolve;
	});
	child.stderr.on("data", (chunk) => {
		stderr = `${stderr}${String(chunk)}`.slice(-4_000);
	});
	child.once("error", (error) => {
		exitResolve();
		fatalReject(new Error(`Could not start Claude Code: ${error.message}`));
	});
	child.once("exit", () => {
		exitResolve();
	});
	child.once("close", (code, signal) => {
		processResolve({ code, signal });
	});
	readline.createInterface({ input: child.stdout }).on("line", (line) => {
		let message: ClaudeMessage;
		try {
			message = JSON.parse(line) as ClaudeMessage;
		} catch {
			fatalReject(
				new Error("Claude Code returned malformed structured output"),
			);
			return;
		}
		if (message.session_id) sessionId = message.session_id;
		if (message.type === "system" && message.subtype === "init") init = message;
		if (
			message.type === "stream_event" &&
			message.event?.type === "content_block_delta" &&
			message.event.delta?.type === "text_delta"
		) {
			request.onPartial();
		}
		if (message.type === "result") result = message;
	});

	let abort: (() => void) | undefined;
	const cancelled = new Promise<never>((_, reject) => {
		abort = () =>
			reject(request.signal?.reason ?? new Error("Claude Code call aborted"));
		request.signal?.addEventListener("abort", abort, { once: true });
	});
	let timeout: NodeJS.Timeout | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		timeout = setTimeout(
			() =>
				reject(
					new Error(`Claude Code call timed out after ${options.timeoutMs}ms`),
				),
			options.timeoutMs,
		);
	});

	try {
		const outcome = await Promise.race([
			processExit,
			fatal,
			cancelled,
			timedOut,
		]);
		if (outcome.code !== 0) {
			const detail = stderr.trim();
			throw new Error(
				`Claude Code exited with ${outcome.code === null ? `signal ${outcome.signal}` : `code ${outcome.code}`}${detail ? `: ${detail}` : ""}`,
			);
		}
		if (!init)
			throw new Error("Claude Code did not return initialization metadata");
		await assertBoundaries(init, request);
		if (!result)
			throw new Error("Claude Code completed without a result message");
		if (
			result.subtype !== "success" ||
			result.is_error ||
			typeof result.result !== "string"
		) {
			throw new Error(
				`Claude Code failed: ${typeof result.result === "string" ? result.result : (result.subtype ?? "unknown error")}`,
			);
		}
		if (!sessionId) throw new Error("Claude Code did not return a session ID");
		return {
			content: result.result,
			providerSessionReference: sessionId,
			source: { provider: "claude", transport: "print-mode" },
		};
	} catch (error) {
		await terminate(child, exited, options.terminationGraceMs);
		const message =
			error instanceof Error ? error.message : "Claude Code call failed";
		throw new CouncilAdapterError(
			message,
			request.signal?.aborted
				? "cancelled"
				: message.includes("timed out")
					? "timed-out"
					: "failed",
			{
				provider: "claude",
				transport: "print-mode",
				nativeReference: sessionId,
			},
			{ cause: error },
		);
	} finally {
		if (timeout) clearTimeout(timeout);
		if (abort) request.signal?.removeEventListener("abort", abort);
	}
}

export function createClaudeCouncilAdapter({
	workingDirectory,
	command = "claude",
	fallback = deterministicFakeAdapter,
	timeoutMs = 120_000,
	terminationGraceMs = 500,
}: Options): CouncilAdapter {
	let claudeMember: string | undefined;
	return {
		selectParticipants(input) {
			claudeMember = undefined;
			return fallback.selectParticipants(input);
		},
		control: fallback.control,
		respond(request) {
			if (
				!claudeMember &&
				request.member.provider === "claude" &&
				request.member.role !== "Chair"
			)
				claudeMember ??= request.member.handle;
			if (request.member.handle !== claudeMember)
				return fallback.respond(request);
			if (
				path.resolve(request.workingDirectory) !==
				path.resolve(workingDirectory)
			)
				throw new Error(
					"Claude Council Member must run in the repository directory active at startup",
				);
			return runClaude(request, {
				command,
				timeoutMs,
				terminationGraceMs,
			});
		},
	};
}
