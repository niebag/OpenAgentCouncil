import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, realpath } from "node:fs/promises";
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

type JsonMessage = {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { message?: string };
};

type Options = {
	workingDirectory: string;
	command?: string;
	fallback?: CouncilAdapter;
	timeoutMs?: number;
	terminationGraceMs?: number;
};

const appServerArguments = [
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
] as const;

function wait(milliseconds: number) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function terminate(
	child: ChildProcessWithoutNullStreams,
	exited: Promise<void>,
	grace: number,
) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.stdin.end();
	if (
		await Promise.race([exited.then(() => true), wait(grace).then(() => false)])
	)
		return;
	child.kill("SIGTERM");
	if (
		await Promise.race([exited.then(() => true), wait(grace).then(() => false)])
	)
		return;
	child.kill("SIGKILL");
	await exited;
}

async function assertBoundaries(
	result: Record<string, unknown>,
	workingDirectory: string,
) {
	const repositoryDirectory = await realpath(workingDirectory);
	const reportedDirectory = await realpath(String(result.cwd)).catch(() => "");
	if (reportedDirectory !== repositoryDirectory) {
		throw new Error(
			`Codex App Server did not preserve the repository directory (received ${String(result.cwd)})`,
		);
	}
	if (result.approvalPolicy !== "never") {
		throw new Error(
			"Codex App Server did not enforce non-interactive approvals",
		);
	}
	const sandbox = result.sandbox as
		| { type?: string; networkAccess?: boolean }
		| undefined;
	if (sandbox?.type !== "readOnly" || sandbox.networkAccess !== false) {
		throw new Error("Codex App Server did not enforce read-only local access");
	}
	const sources = result.instructionSources;
	if (!Array.isArray(sources)) {
		throw new Error("Codex App Server did not report its instruction sources");
	}
	const resolvedSources = await Promise.all(
		sources.map((source) =>
			realpath(String(source)).catch(() => path.resolve(String(source))),
		),
	);
	for (const resolvedSource of resolvedSources) {
		const relative = path.relative(repositoryDirectory, resolvedSource);
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(
				`Codex App Server loaded a personal instruction source: ${resolvedSource}`,
			);
		}
	}
	const repositoryInstructions = path.join(workingDirectory, "AGENTS.md");
	if (
		await access(repositoryInstructions).then(
			() => true,
			() => false,
		)
	) {
		if (!resolvedSources.includes(await realpath(repositoryInstructions)))
			throw new Error("Codex App Server did not load repository AGENTS.md");
	}
}

async function runCodex(
	request: CouncilRequest,
	options: Required<
		Pick<Options, "command" | "timeoutMs" | "terminationGraceMs">
	>,
): Promise<CouncilResponse> {
	request.signal?.throwIfAborted();
	const child = spawn(options.command, [...appServerArguments], {
		cwd: request.workingDirectory,
		stdio: "pipe",
	});
	let exitResolve: () => void = () => {};
	const exited = new Promise<void>((resolve) => {
		exitResolve = resolve;
	});
	let stderr = "";
	let nextId = 1;
	let threadId: string | undefined;
	let turnId: string | undefined;
	let completed = false;
	let finalContent = "";
	let fallbackContent = "";
	const pending = new Map<
		number,
		{
			resolve: (value: Record<string, unknown>) => void;
			reject: (error: Error) => void;
		}
	>();
	let fatalReject: (error: Error) => void = () => {};
	const fatal = new Promise<never>((_, reject) => {
		fatalReject = reject;
	});
	let completionResolve: () => void = () => {};
	const completion = new Promise<void>((resolve) => {
		completionResolve = resolve;
	});
	const fail = (error: Error) => {
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
		fatalReject(error);
	};
	const send = (method: string, params?: Record<string, unknown>) => {
		const id = nextId;
		nextId += 1;
		const response = new Promise<Record<string, unknown>>((resolve, reject) =>
			pending.set(id, { resolve, reject }),
		);
		child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		return response;
	};

	child.stderr.on("data", (chunk) => {
		stderr = `${stderr}${String(chunk)}`.slice(-4_000);
	});
	child.once("error", (error) =>
		fail(new Error(`Could not start Codex App Server: ${error.message}`)),
	);
	child.once("exit", (code, signal) => {
		exitResolve();
		if (!completed) {
			const detail = stderr.trim();
			fail(
				new Error(
					`Codex App Server exited with ${code === null ? `signal ${signal}` : `code ${code}`}${detail ? `: ${detail}` : ""}`,
				),
			);
		}
	});
	readline.createInterface({ input: child.stdout }).on("line", (line) => {
		let message: JsonMessage;
		try {
			message = JSON.parse(line) as JsonMessage;
		} catch {
			fail(new Error("Codex returned a malformed App Server message"));
			return;
		}
		if (message.id !== undefined && !message.method) {
			const waiter = pending.get(message.id);
			if (!waiter) return;
			pending.delete(message.id);
			if (message.error)
				waiter.reject(
					new Error(
						`Codex App Server rejected the request: ${message.error.message ?? "unknown error"}`,
					),
				);
			else waiter.resolve(message.result ?? {});
			return;
		}
		if (message.id !== undefined && message.method) {
			fail(
				new Error(
					`Codex App Server requested disallowed interaction: ${message.method}`,
				),
			);
			return;
		}
		if (message.method === "item/agentMessage/delta") request.onPartial();
		if (message.method === "item/completed") {
			const item = message.params?.item as
				| { type?: string; text?: string; phase?: string }
				| undefined;
			if (item?.type === "agentMessage" && typeof item.text === "string") {
				if (item.phase === "final_answer") finalContent = item.text;
				else fallbackContent = item.text;
			}
		}
		if (message.method === "error" && message.params?.willRetry === false) {
			const error = message.params.error as { message?: string } | undefined;
			fail(
				new Error(
					`Codex App Server failed: ${error?.message ?? "unknown error"}`,
				),
			);
		}
		if (message.method === "turn/completed") {
			const turn = message.params?.turn as
				| { status?: string; error?: { message?: string } }
				| undefined;
			if (turn?.status === "failed")
				fail(
					new Error(
						`Codex turn failed: ${turn.error?.message ?? "unknown error"}`,
					),
				);
			else if (turn?.status === "interrupted")
				fail(new Error("Codex turn was interrupted"));
			else if (turn?.status === "completed") {
				completed = true;
				completionResolve();
			}
		}
	});

	let abort: (() => void) | undefined;
	const cancelled = new Promise<never>((_, reject) => {
		abort = () =>
			reject(request.signal?.reason ?? new Error("Codex call aborted"));
		request.signal?.addEventListener("abort", abort, { once: true });
	});
	let timeout: NodeJS.Timeout | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		timeout = setTimeout(
			() =>
				reject(new Error(`Codex call timed out after ${options.timeoutMs}ms`)),
			options.timeoutMs,
		);
	});
	const race = <Value>(operation: Promise<Value>) =>
		Promise.race([operation, fatal, cancelled, timedOut]);

	try {
		await race(
			send("initialize", {
				clientInfo: {
					name: "openagentcouncil",
					title: "OpenAgentCouncil",
					version: "0.1.0",
				},
				capabilities: {
					experimentalApi: false,
					requestAttestation: false,
				},
			}),
		);
		child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
		const hasWeb = request.member.capabilities?.includes("web") ?? false;
		const config = {
			web_search: hasWeb ? "live" : "disabled",
			...(hasWeb ? { tools: { web_search: {} } } : {}),
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
			...(request.member.reasoningEffort
				? { model_reasoning_effort: request.member.reasoningEffort }
				: {}),
		};
		const threadParams = {
			cwd: request.workingDirectory,
			sandbox: "read-only",
			approvalPolicy: "never",
			config,
			developerInstructions: request.member.profileContent,
			personality: "none",
			...(request.member.model ? { model: request.member.model } : {}),
		};
		const thread = await race(
			request.providerSessionReference
				? send("thread/resume", {
						threadId: request.providerSessionReference,
						...threadParams,
					})
				: send("thread/start", threadParams),
		);
		await assertBoundaries(thread, request.workingDirectory);
		threadId = String((thread.thread as { id?: string } | undefined)?.id ?? "");
		if (!threadId)
			throw new Error("Codex App Server did not return a thread ID");
		const turn = await race(
			send("turn/start", {
				threadId,
				input: [
					{
						type: "text",
						text: councilPrompt(request),
						text_elements: [],
					},
				],
				cwd: request.workingDirectory,
				approvalPolicy: "never",
				sandboxPolicy: { type: "readOnly", networkAccess: false },
			}),
		);
		turnId = String((turn.turn as { id?: string } | undefined)?.id ?? "");
		if (!turnId) throw new Error("Codex App Server did not return a turn ID");
		await race(completion);
		const content = finalContent || fallbackContent;
		if (!content)
			throw new Error("Codex completed without a completed agent message");
		return {
			content,
			providerSessionReference: threadId,
			source: { provider: "codex", transport: "app-server" },
		};
	} catch (error) {
		if (threadId && turnId && child.stdin.writable) {
			const id = nextId;
			nextId += 1;
			child.stdin.write(
				`${JSON.stringify({ id, method: "turn/interrupt", params: { threadId, turnId } })}\n`,
			);
		}
		const message =
			error instanceof Error ? error.message : "Codex call failed";
		throw new CouncilAdapterError(
			message,
			request.signal?.aborted
				? "cancelled"
				: message.includes("timed out")
					? "timed-out"
					: "failed",
			{
				provider: "codex",
				transport: "app-server",
				nativeReference: threadId,
			},
			{ cause: error },
		);
	} finally {
		if (timeout) clearTimeout(timeout);
		if (abort) request.signal?.removeEventListener("abort", abort);
		await terminate(child, exited, options.terminationGraceMs);
	}
}

export function createCodexCouncilAdapter({
	workingDirectory,
	command = "codex",
	fallback = deterministicFakeAdapter,
	timeoutMs = 120_000,
	terminationGraceMs = 500,
}: Options): CouncilAdapter {
	let codexMember: string | undefined;
	return {
		selectParticipants: fallback.selectParticipants,
		control: fallback.control,
		respond(request) {
			if (
				request.member.provider === "codex" &&
				request.member.role !== "Chair"
			)
				codexMember ??= request.member.handle;
			if (request.member.handle !== codexMember)
				return fallback.respond(request);
			if (
				path.resolve(request.workingDirectory) !==
				path.resolve(workingDirectory)
			)
				throw new Error(
					"Codex Council Member must run in the repository directory active at startup",
				);
			return runCodex(request, {
				command,
				timeoutMs,
				terminationGraceMs,
			});
		},
	};
}
