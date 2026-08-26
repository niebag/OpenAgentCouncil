import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
	chmod,
	lstat,
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Council, Member, Provider } from "./configuration.js";

const execFile = promisify(execFileCallback);

type SessionMember = Member & { profileContent: string };

type CouncilPhase =
	| "position"
	| "round"
	| "draft-recommendation"
	| "review"
	| "recommendation";

type ContributionEntry = {
	[Kind in CouncilPhase]: {
		kind: Kind;
		deliberationId: string;
		member: string;
		content: string;
		createdAt: string;
		source?: CouncilSource;
	};
}[CouncilPhase];

export type TimelineEntry =
	| {
			kind: "question";
			deliberationId: string;
			content: string;
			createdAt: string;
	  }
	| ContributionEntry
	| {
			kind: "assignment-proposal";
			deliberationId: string;
			member: string;
			goal: string;
			expectedFiles: string[];
			content: string;
			createdAt: string;
	  }
	| {
			kind: "assignment-decision";
			deliberationId: string;
			member: string;
			decision: AssignmentDecision;
			content: string;
			createdAt: string;
	  }
	| {
			kind: "artifact";
			deliberationId: string;
			member: string;
			content: string;
			diff: string;
			expectedFiles: string[];
			approval: { decision: "approved"; decidedAt: string };
			createdAt: string;
			source?: CouncilSource;
	  }
	| {
			kind: "member-failure";
			deliberationId: string;
			member: string;
			phase: CouncilPhase;
			content: string;
			createdAt: string;
			source?: CouncilSource;
			outcome?: CouncilFailureOutcome;
	  }
	| {
			kind: "incomplete-deliberation";
			deliberationId: string;
			member: string;
			reason: IncompleteReason;
			content: string;
			createdAt: string;
	  };
type IncompleteReason =
	| "missing-quorum"
	| "missing-review"
	| "chair-failure"
	| "cancelled";

export type DeliberationOutcome =
	| { kind: "recommendation" }
	| { kind: "incomplete-deliberation"; reason: IncompleteReason };

export type Deliberation = {
	id: string;
	question: string;
	startedAt: string;
	completedAt?: string;
	outcome?: DeliberationOutcome;
	providerSessionReferences: Record<string, string>;
};

export type Session = {
	version: 1;
	id: string;
	startedAt: string;
	workingDirectory: string;
	council: { name: string; members: SessionMember[] };
	deliberations: Deliberation[];
	timeline: TimelineEntry[];
};

export type RuntimeEvent =
	| {
			kind: "member-status";
			member: string;
			status: "working" | "typing" | "completed" | "failed";
	  }
	| { kind: "content"; entry: Exclude<TimelineEntry, { kind: "question" }> }
	| {
			kind: "provider-outcome";
			member: string;
			outcome: CouncilFailureOutcome;
			source?: CouncilSource;
			error: string;
	  };

export type CouncilSource = {
	provider: Provider;
	transport: "app-server" | "print-mode";
	nativeReference?: string;
};

export type CouncilFailureOutcome = "failed" | "cancelled" | "timed-out";

export class CouncilAdapterError extends Error {
	constructor(
		message: string,
		readonly outcome: CouncilFailureOutcome,
		readonly source: CouncilSource,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

export type CouncilResponse = {
	content: string;
	providerSessionReference?: string;
	source: CouncilSource;
};

export type CouncilControlResponse = {
	content: string;
	providerSessionReference?: string;
};

export type AssignmentProposal = {
	member: string;
	goal: string;
	expectedFiles: string[];
};

export type AssignmentDecision = "approved" | "rejected";

export type CouncilRequest = {
	phase: CouncilPhase | "assignment";
	member: SessionMember;
	question: string;
	priorContent: string[];
	assignment?: AssignmentProposal;
	workingDirectory: string;
	providerSessionReference?: string;
	signal?: AbortSignal;
	onPartial: () => void;
	control?: CouncilControlRequest;
};

export function councilPrompt(request: CouncilRequest) {
	if (request.control) {
		const control = request.control;
		if (control.phase === "finalization")
			return [
				"Finalize the reviewed Recommendation. Return only this JSON object:",
				'{"kind":"finalize-recommendation"}',
			].join("\n\n");
		return [
			"Direct the next Council step. Return only one JSON object and no Markdown.",
			'Open a Round: {"kind":"open-round","members":["handle"]}',
			'Draft the Recommendation: {"kind":"draft-recommendation"}',
			'Propose one Assignment: {"kind":"propose-assignment","member":"handle","goal":"...","expectedFiles":["path"]}',
			`Question:\n${control.question}`,
			`Available Council Members:\n${control.members
				.filter((member) => member.role !== "Chair")
				.map((member) => `- ${member.handle} (${member.role})`)
				.join("\n")}`,
			control.priorContent.length > 0
				? `Prior completed Council content:\n${control.priorContent.join("\n\n")}`
				: "",
			`Round: ${control.round}`,
			control.malformedControl
				? `Repair this invalid control:\n${control.malformedControl}\n\nValidation error: ${control.validationError}`
				: "",
		]
			.filter(Boolean)
			.join("\n\n");
	}
	if (request.phase === "assignment") {
		return [
			"Complete the approved Assignment in the repository. Network access is disabled.",
			`Goal:\n${request.assignment?.goal}`,
			`Expected files (intent, not an allowlist):\n${request.assignment?.expectedFiles.join("\n")}`,
			"Return a concise description of the resulting Artifact.",
		].join("\n\n");
	}
	const action =
		request.phase === "position"
			? "Form your independent Position for this Council Deliberation."
			: request.phase === "review"
				? "Review the Draft Recommendation for errors, omissions, and material Dissent."
				: `Contribute to the Council ${request.phase}.`;
	return [
		`${action} Return only the completed ${request.phase === "position" ? "Position" : "contribution"} in Markdown.`,
		`Question:\n${request.question}`,
		request.priorContent.length > 0
			? `Prior completed Council content:\n${request.priorContent.join("\n\n")}`
			: "",
	]
		.filter(Boolean)
		.join("\n\n");
}

export type CouncilControlRequest = {
	phase: "round" | "finalization";
	chair: SessionMember;
	members: SessionMember[];
	question: string;
	round: number;
	priorContent: string[];
	providerSessionReference?: string;
	signal?: AbortSignal;
	malformedControl?: string;
	validationError?: string;
};

export type CouncilAdapter = {
	selectParticipants(input: {
		chair: SessionMember;
		members: SessionMember[];
		question: string;
		requestedMembers: string[];
		malformedControl?: string;
	}): string | Promise<string>;
	control(
		request: CouncilControlRequest,
	): string | CouncilControlResponse | Promise<string | CouncilControlResponse>;
	respond(
		request: CouncilRequest,
	): string | CouncilResponse | Promise<string | CouncilResponse>;
};

const deliberationBudget = { openRounds: 2, providerCalls: 20 } as const;
let assignmentActive = false;

export const deterministicFakeAdapter: CouncilAdapter = {
	selectParticipants({ members }) {
		const selected = members
			.filter(
				(member) => member.role === "Researcher" || member.role === "Critic",
			)
			.map((member) => member.handle);
		return JSON.stringify({
			kind: "select-participants",
			members:
				selected.length >= 2
					? selected
					: members
							.filter((member) => member.role !== "Chair")
							.slice(0, 2)
							.map((member) => member.handle),
		});
	},
	control({ phase }) {
		return JSON.stringify({
			kind:
				phase === "round" ? "draft-recommendation" : "finalize-recommendation",
		});
	},
	respond({ phase, member, question }) {
		const subject = `“${question}”`;
		if (phase === "position")
			return `${member.role} Position on ${subject}. No research claims.`;
		if (phase === "round")
			return `${member.role} Round on ${subject}. No research claims.`;
		if (phase === "draft-recommendation")
			return `Draft Recommendation for ${subject}.`;
		if (phase === "review")
			return `Review completed for ${subject}. No material Dissent.`;
		return [
			"## Synthesis",
			`Recommendation for ${subject}.`,
			"## Reasoning",
			"The completed Positions and reviews support this synthesis.",
			"## Uncertainty",
			"The deterministic adapter provides no external evidence.",
			"## Sources",
			"No research claims.",
			"## Dissent",
			"No material Dissent.",
		].join("\n");
	},
};

function requestedMemberHandles(question: string, members: SessionMember[]) {
	return members
		.filter(
			(member) =>
				member.role !== "Chair" &&
				new RegExp(
					`(^|[\\s([{])@${member.handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s.,!?;:)\\]}])`,
				).test(question),
		)
		.map((member) => member.handle);
}

function participantHandles(
	control: string,
	members: SessionMember[],
	requestedMembers: string[],
) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(control);
	} catch {
		throw new Error("Chair participant selection must be valid JSON");
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		(parsed as { kind?: unknown }).kind !== "select-participants" ||
		!Array.isArray((parsed as { members?: unknown }).members)
	) {
		throw new Error(
			"Chair participant selection has an invalid control envelope",
		);
	}
	const handles = (parsed as { members: unknown[] }).members;
	if (
		handles.length < 2 ||
		handles.some(
			(handle) =>
				typeof handle !== "string" ||
				!members.some(
					(member) => member.handle === handle && member.role !== "Chair",
				),
		) ||
		new Set(handles).size !== handles.length ||
		requestedMembers.some((handle) => !handles.includes(handle))
	) {
		throw new Error(
			"Chair participant selection must include valid requested Members",
		);
	}
	return handles as string[];
}

type RoundAction =
	| { kind: "draft-recommendation" }
	| { kind: "open-round"; members: string[] }
	| ({ kind: "propose-assignment" } & AssignmentProposal);

function roundControl(
	control: string,
	participants: SessionMember[],
	allMembers: SessionMember[],
): RoundAction {
	let parsed: unknown;
	try {
		parsed = JSON.parse(control);
	} catch {
		throw new Error("Chair Round control must be valid JSON");
	}
	if (
		parsed &&
		typeof parsed === "object" &&
		!Array.isArray(parsed) &&
		(parsed as { kind?: unknown }).kind === "draft-recommendation"
	) {
		return { kind: "draft-recommendation" };
	}
	if (
		parsed &&
		typeof parsed === "object" &&
		!Array.isArray(parsed) &&
		(parsed as { kind?: unknown }).kind === "propose-assignment"
	) {
		const proposal = parsed as Record<string, unknown>;
		if (
			typeof proposal.member !== "string" ||
			!allMembers.some(
				(member) =>
					member.handle === proposal.member && member.role !== "Chair",
			) ||
			typeof proposal.goal !== "string" ||
			proposal.goal.trim().length === 0 ||
			!Array.isArray(proposal.expectedFiles) ||
			proposal.expectedFiles.length === 0 ||
			proposal.expectedFiles.some(
				(file) => typeof file !== "string" || file.trim().length === 0,
			)
		) {
			throw new Error(
				"Chair Assignment proposal must name a Council Member, goal, and expected files",
			);
		}
		return {
			kind: "propose-assignment",
			member: proposal.member,
			goal: proposal.goal,
			expectedFiles: proposal.expectedFiles as string[],
		};
	}
	const members = (parsed as { kind?: unknown; members?: unknown })?.members;
	if (
		!parsed ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		(parsed as { kind?: unknown }).kind !== "open-round" ||
		!Array.isArray(members) ||
		members.length === 0 ||
		members.some(
			(handle) =>
				typeof handle !== "string" ||
				!participants.some((member) => member.handle === handle),
		) ||
		new Set(members).size !== members.length
	) {
		throw new Error("Chair Round control must select participating Members");
	}
	return { kind: "open-round", members: members as string[] };
}

async function repositorySnapshot(directory: string) {
	const temporaryDirectory = await mkdtemp(
		path.join(os.tmpdir(), "openagentcouncil-index-"),
	);
	const environment = {
		...process.env,
		GIT_INDEX_FILE: path.join(temporaryDirectory, "index"),
	};
	try {
		await execFile("git", ["read-tree", "HEAD"], {
			cwd: directory,
			env: environment,
		});
		await execFile("git", ["add", "-A", "--", "."], {
			cwd: directory,
			env: environment,
		});
		return (
			await execFile("git", ["write-tree"], {
				cwd: directory,
				env: environment,
			})
		).stdout.trim();
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

async function repositoryDiff(directory: string, before: string) {
	const after = await repositorySnapshot(directory);
	return (
		await execFile(
			"git",
			["diff", "--no-ext-diff", "--no-color", "--binary", before, after],
			{ cwd: directory, maxBuffer: 10 * 1024 * 1024 },
		)
	).stdout;
}

function finalizationControl(control: string) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(control);
	} catch {
		throw new Error("Chair finalization control must be valid JSON");
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		(parsed as { kind?: unknown }).kind !== "finalize-recommendation"
	) {
		throw new Error(
			"Chair finalization control must finalize the Recommendation",
		);
	}
}

function validateRecommendation(
	content: string,
	participants: SessionMember[],
	contributions: ContributionEntry[],
) {
	const names = [
		"Synthesis",
		"Reasoning",
		"Uncertainty",
		"Sources",
		"Dissent",
	] as const;
	const sections = Object.fromEntries(
		names.map((name) => {
			const match = content.match(
				new RegExp(
					`^#{1,6}\\s+${name}\\s*$\\n([\\s\\S]*?)(?=^#{1,6}\\s+(?:${names.join("|")})\\s*$|(?![\\s\\S]))`,
					"im",
				),
			);
			if (!match?.[1]?.trim()) {
				throw new Error(`Recommendation must include a ${name} section`);
			}
			return [name, match[1]];
		}),
	) as Record<(typeof names)[number], string>;
	if (
		!/https?:\/\/\S+/i.test(sections.Sources) &&
		(!/no research claims/i.test(sections.Sources) ||
			contributions.some((entry) => {
				const member = participants.find(
					(participant) => participant.handle === entry.member,
				);
				return (
					(entry.kind === "position" || entry.kind === "round") &&
					(member?.role === "Researcher" ||
						member?.capabilities?.includes("web")) &&
					!/no research claims/i.test(entry.content)
				);
			}))
	) {
		throw new Error(
			"Recommendation Sources must include a concrete URL or state that there are no research claims",
		);
	}
	for (const url of contributions.flatMap(
		(entry) => entry.content.match(/https?:\/\/\S+/gi) ?? [],
	)) {
		if (!sections.Sources.includes(url)) {
			throw new Error("Recommendation Sources must preserve contribution URLs");
		}
	}
	if (
		!/no material dissent/i.test(sections.Dissent) &&
		!participants.some((member) =>
			new RegExp(
				`@${member.handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`,
				"i",
			).test(sections.Dissent),
		)
	) {
		throw new Error(
			"Recommendation Dissent must be attributed to a participating Member",
		);
	}
	for (const review of contributions.filter(
		(entry) => entry.kind === "review",
	)) {
		if (
			!/no material dissent/i.test(review.content) &&
			!new RegExp(
				`@${review.member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`,
				"i",
			).test(sections.Dissent)
		) {
			throw new Error(
				`Recommendation Dissent must include @${review.member}'s review`,
			);
		}
	}
}

export async function readProfileContents(
	directory: string,
	council: Council,
): Promise<Record<string, string>> {
	const entries = await Promise.all(
		council.members.map(
			async (member) =>
				[
					member.profile,
					await readFile(path.join(directory, member.profile), "utf8"),
				] as const,
		),
	);
	return Object.fromEntries(entries);
}

export function createSession({
	council,
	workingDirectory,
	profileContents,
	now = () => new Date().toISOString(),
}: {
	council: Council;
	workingDirectory: string;
	profileContents: Record<string, string>;
	now?: () => string;
}): Session {
	return {
		version: 1,
		id: randomUUID(),
		startedAt: now(),
		workingDirectory,
		council: {
			name: council.name,
			members: council.members.map((member) => ({
				...member,
				capabilities: member.capabilities && [...member.capabilities],
				profileContent: profileContents[member.profile] ?? "",
			})),
		},
		deliberations: [],
		timeline: [],
	};
}

export function appendUserInput(
	session: Session,
	content: string,
	now = () => new Date().toISOString(),
) {
	const deliberation = session.deliberations.at(-1);
	if (!deliberation || deliberation.outcome)
		throw new Error("No active Deliberation is available");
	const input = content.trim();
	if (!input) throw new Error("Additional user input must be non-empty");
	const entry: Extract<TimelineEntry, { kind: "question" }> = {
		kind: "question",
		deliberationId: deliberation.id,
		content: input,
		createdAt: now(),
	};
	session.timeline.push(entry);
	return entry;
}

export async function runDeliberation(
	session: Session,
	question: string,
	{
		adapter = deterministicFakeAdapter,
		now = () => new Date().toISOString(),
		onEvent,
		onAssignmentProposal,
		signal,
	}: {
		adapter?: CouncilAdapter;
		now?: () => string;
		onEvent?: (event: RuntimeEvent) => void;
		onAssignmentProposal?: (
			proposal: AssignmentProposal,
		) => AssignmentDecision | Promise<AssignmentDecision>;
		signal?: AbortSignal;
	} = {},
): Promise<RuntimeEvent[]> {
	const deliberation: Deliberation = {
		id: `deliberation-${session.deliberations.length + 1}`,
		question,
		startedAt: now(),
		providerSessionReferences: {},
	};
	session.deliberations.push(deliberation);
	const initialQuestion: Extract<TimelineEntry, { kind: "question" }> = {
		kind: "question",
		deliberationId: deliberation.id,
		content: question,
		createdAt: deliberation.startedAt,
	};
	session.timeline.push(initialQuestion);

	const events: RuntimeEvent[] = [];
	const emit = (event: RuntimeEvent) => {
		events.push(event);
		onEvent?.(event);
	};
	const chair = session.council.members.find(
		(member) => member.role === "Chair",
	);
	if (!chair) throw new Error("Council requires a Chair and Quorum");
	let providerCalls = 0;
	const call = async <T>(
		operation: () => T | Promise<T>,
		cancelPromise = false,
	): Promise<T> => {
		signal?.throwIfAborted();
		if (providerCalls >= deliberationBudget.providerCalls) {
			throw new Error("Deliberation provider-call budget exhausted");
		}
		providerCalls += 1;
		const result = Promise.resolve().then(operation);
		if (!signal || !cancelPromise) return result;
		let abort: () => void = () => {};
		const cancelled = new Promise<never>((_, reject) => {
			abort = () => reject(signal.reason ?? new Error("Deliberation aborted"));
			signal.addEventListener("abort", abort, { once: true });
		});
		try {
			return await Promise.race([result, cancelled]);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	};
	const contributions = () =>
		session.timeline.filter(
			(entry): entry is ContributionEntry =>
				entry.deliberationId === deliberation.id &&
				(entry.kind === "position" ||
					entry.kind === "round" ||
					entry.kind === "draft-recommendation" ||
					entry.kind === "review" ||
					entry.kind === "recommendation"),
		);
	const visibleContent = () =>
		session.timeline.flatMap((entry) =>
			entry.deliberationId === deliberation.id && entry !== initialQuestion
				? [
						entry.kind === "question"
							? `User (additional input):\n${entry.content}`
							: `${"member" in entry ? `@${entry.member}` : "Council"} (${entry.kind}):\n${entry.content}`,
					]
				: [],
		);
	const userInputRevision = () =>
		session.timeline.filter(
			(entry) =>
				entry.deliberationId === deliberation.id && entry.kind === "question",
		).length;
	const collectContribution = async (
		kind: CouncilPhase,
		member: SessionMember,
		priorContent: string[],
		validate?: (content: string) => void,
	) => {
		const inputRevision = userInputRevision();
		emit({ kind: "member-status", member: member.handle, status: "working" });
		let typing = false;
		const onPartial = () => {
			if (typing) return;
			typing = true;
			emit({ kind: "member-status", member: member.handle, status: "typing" });
		};
		try {
			const response = await call(() =>
				adapter.respond({
					phase: kind,
					member,
					question,
					priorContent,
					workingDirectory: session.workingDirectory,
					providerSessionReference:
						deliberation.providerSessionReferences[member.handle],
					signal,
					onPartial,
				}),
			);
			signal?.throwIfAborted();
			const result: {
				content: string;
				providerSessionReference?: string;
				source?: CouncilSource;
			} = typeof response === "string" ? { content: response } : response;
			const { content } = result;
			if (result.providerSessionReference) {
				deliberation.providerSessionReferences[member.handle] =
					result.providerSessionReference;
			}
			if (member.role === "Chair" && inputRevision !== userInputRevision())
				return collectContribution(kind, member, visibleContent(), validate);
			if (content.trim().length === 0) {
				throw new Error(`${kind} content must be non-empty`);
			}
			onPartial();
			validate?.(content);
			const entry = {
				kind,
				deliberationId: deliberation.id,
				member: member.handle,
				content,
				createdAt: now(),
				...(result.source
					? {
							source: {
								...result.source,
								nativeReference: result.providerSessionReference,
							},
						}
					: {}),
			} as Extract<TimelineEntry, { kind: CouncilPhase }>;
			session.timeline.push(entry);
			emit({ kind: "content", entry });
			emit({
				kind: "member-status",
				member: member.handle,
				status: "completed",
			});
			return entry;
		} catch (error) {
			const adapterError =
				error instanceof CouncilAdapterError ? error : undefined;
			const message = error instanceof Error ? error.message : "unknown error";
			emit({
				kind: "provider-outcome",
				member: member.handle,
				outcome:
					adapterError?.outcome ?? (signal?.aborted ? "cancelled" : "failed"),
				source: adapterError?.source,
				error: message,
			});
			if (signal?.aborted) throw error;
			const entry: Extract<TimelineEntry, { kind: "member-failure" }> = {
				kind: "member-failure",
				deliberationId: deliberation.id,
				member: member.handle,
				phase: kind,
				content: `${member.handle} failed during ${kind}: ${message}`,
				createdAt: now(),
				source: adapterError?.source,
				outcome: adapterError?.outcome,
			};
			session.timeline.push(entry);
			emit({ kind: "content", entry });
			emit({ kind: "member-status", member: member.handle, status: "failed" });
			throw error;
		}
	};
	const incomplete = (reason: IncompleteReason, detail: string) => {
		const entry: Extract<TimelineEntry, { kind: "incomplete-deliberation" }> = {
			kind: "incomplete-deliberation",
			deliberationId: deliberation.id,
			member: chair.handle,
			reason,
			content: `Incomplete Deliberation: ${detail}`,
			createdAt: now(),
		};
		deliberation.outcome = { kind: "incomplete-deliberation", reason };
		deliberation.completedAt = now();
		session.timeline.push(entry);
		emit({ kind: "content", entry });
		return events;
	};
	const cancel = () => incomplete("cancelled", "cancelled by the user");
	const getControl = async <Result>(
		phase: CouncilControlRequest["phase"],
		round: number,
		parse: (control: string) => Result,
	) => {
		let malformedControl: string | undefined;
		let validationError: string | undefined;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const response = await call(() =>
				adapter.control({
					phase,
					chair,
					members: session.council.members,
					question,
					round,
					priorContent: visibleContent(),
					providerSessionReference:
						deliberation.providerSessionReferences[chair.handle],
					signal,
					malformedControl,
					validationError,
				}),
			);
			const result =
				typeof response === "string" ? { content: response } : response;
			if (result.providerSessionReference)
				deliberation.providerSessionReferences[chair.handle] =
					result.providerSessionReference;
			try {
				return parse(result.content);
			} catch (error) {
				if (attempt === 1) throw error;
				malformedControl = result.content;
				validationError =
					error instanceof Error ? error.message : "invalid Chair control";
			}
		}
		throw new Error("Chair control repair failed");
	};
	const selection = {
		chair,
		members: session.council.members,
		question,
		requestedMembers: requestedMemberHandles(question, session.council.members),
	};
	let control: string;
	try {
		control = await call(() => adapter.selectParticipants(selection), true);
	} catch (error) {
		if (signal?.aborted) return cancel();
		throw error;
	}
	let handles: string[];
	try {
		handles = participantHandles(
			control,
			session.council.members,
			selection.requestedMembers,
		);
	} catch {
		try {
			control = await call(
				() =>
					adapter.selectParticipants({
						...selection,
						malformedControl: control,
					}),
				true,
			);
			handles = participantHandles(
				control,
				session.council.members,
				selection.requestedMembers,
			);
		} catch (repairError) {
			if (signal?.aborted) return cancel();
			throw repairError;
		}
	}
	const participants = handles.map((handle) =>
		session.council.members.find((member) => member.handle === handle),
	) as SessionMember[];

	const positionResults = await Promise.allSettled(
		participants.map((member) => collectContribution("position", member, [])),
	);
	const positions = positionResults.flatMap((result) =>
		result.status === "fulfilled" ? [result.value] : [],
	);
	if (signal?.aborted) return cancel();
	if (new Set(positions.map((position) => position.member)).size < 2) {
		return incomplete(
			"missing-quorum",
			"Quorum requires two completed Positions",
		);
	}

	try {
		let assignmentProposed = false;
		for (let round = 1; round <= deliberationBudget.openRounds; round += 1) {
			const action = await getControl("round", round, (value) =>
				roundControl(value, participants, session.council.members),
			);
			if (action.kind === "draft-recommendation") break;
			if (action.kind === "propose-assignment") {
				if (assignmentProposed)
					throw new Error("A Deliberation may propose only one Assignment");
				assignmentProposed = true;
				const proposal: AssignmentProposal = {
					member: action.member,
					goal: action.goal,
					expectedFiles: action.expectedFiles,
				};
				const proposedAt = now();
				const proposalEntry: Extract<
					TimelineEntry,
					{ kind: "assignment-proposal" }
				> = {
					kind: "assignment-proposal",
					deliberationId: deliberation.id,
					...proposal,
					content: `Assignment proposed for @${proposal.member}\nGoal: ${proposal.goal}\nExpected files:\n${proposal.expectedFiles.map((file) => `- ${file}`).join("\n")}`,
					createdAt: proposedAt,
				};
				session.timeline.push(proposalEntry);
				emit({ kind: "content", entry: proposalEntry });
				const decision = (await onAssignmentProposal?.(proposal)) ?? "rejected";
				const decidedAt = now();
				const decisionEntry: Extract<
					TimelineEntry,
					{ kind: "assignment-decision" }
				> = {
					kind: "assignment-decision",
					deliberationId: deliberation.id,
					member: proposal.member,
					decision,
					content: `Assignment ${decision} for @${proposal.member}.`,
					createdAt: decidedAt,
				};
				session.timeline.push(decisionEntry);
				emit({ kind: "content", entry: decisionEntry });
				if (decision === "rejected") continue;
				if (assignmentActive)
					throw new Error("Another approved Assignment is already writing");
				assignmentActive = true;
				const member = session.council.members.find(
					(candidate) => candidate.handle === proposal.member,
				) as SessionMember;
				emit({
					kind: "member-status",
					member: member.handle,
					status: "working",
				});
				try {
					const before = await repositorySnapshot(session.workingDirectory);
					const recordArtifact = (
						content: string,
						diff: string,
						source?: CouncilSource,
					) => {
						const artifact: Extract<TimelineEntry, { kind: "artifact" }> = {
							kind: "artifact",
							deliberationId: deliberation.id,
							member: member.handle,
							content,
							diff,
							expectedFiles: proposal.expectedFiles,
							approval: { decision: "approved", decidedAt },
							createdAt: now(),
							...(source ? { source } : {}),
						};
						session.timeline.push(artifact);
						emit({ kind: "content", entry: artifact });
					};
					let typing = false;
					let result: {
						content: string;
						providerSessionReference?: string;
						source?: CouncilSource;
					};
					try {
						const response = await call(() =>
							adapter.respond({
								phase: "assignment",
								member,
								question,
								priorContent: visibleContent(),
								assignment: proposal,
								workingDirectory: session.workingDirectory,
								providerSessionReference:
									deliberation.providerSessionReferences[member.handle],
								signal,
								onPartial() {
									if (typing) return;
									typing = true;
									emit({
										kind: "member-status",
										member: member.handle,
										status: "typing",
									});
								},
							}),
						);
						result =
							typeof response === "string" ? { content: response } : response;
						if (result.content.trim().length === 0)
							throw new Error("Artifact description must be non-empty");
					} catch (error) {
						const diff = await repositoryDiff(session.workingDirectory, before);
						if (diff)
							recordArtifact(
								`Assignment failed after modifying the workspace: ${error instanceof Error ? error.message : "unknown error"}`,
								diff,
								error instanceof CouncilAdapterError ? error.source : undefined,
							);
						emit({
							kind: "member-status",
							member: member.handle,
							status: "failed",
						});
						throw error;
					}
					if (result.providerSessionReference)
						deliberation.providerSessionReferences[member.handle] =
							result.providerSessionReference;
					recordArtifact(
						result.content,
						await repositoryDiff(session.workingDirectory, before),
						result.source,
					);
					emit({
						kind: "member-status",
						member: member.handle,
						status: "completed",
					});
				} finally {
					assignmentActive = false;
				}
				continue;
			}
			const priorContent = visibleContent();
			await Promise.allSettled(
				action.members.map((handle) =>
					collectContribution(
						"round",
						participants.find(
							(member) => member.handle === handle,
						) as SessionMember,
						priorContent,
					),
				),
			);
		}
	} catch (error) {
		if (signal?.aborted) return cancel();
		emit({ kind: "member-status", member: chair.handle, status: "failed" });
		return incomplete(
			"chair-failure",
			error instanceof Error ? error.message : "Chair Round control failed",
		);
	}

	let draft: Extract<TimelineEntry, { kind: CouncilPhase }>;
	try {
		draft = await collectContribution(
			"draft-recommendation",
			chair,
			visibleContent(),
		);
	} catch (error) {
		if (signal?.aborted) return cancel();
		return incomplete(
			"chair-failure",
			error instanceof Error ? error.message : "Chair draft failed",
		);
	}
	const reviewResults = await Promise.allSettled(
		participants.map((member) =>
			collectContribution("review", member, [draft.content]),
		),
	);
	const reviews = reviewResults.flatMap((result) =>
		result.status === "fulfilled" ? [result.value] : [],
	);
	if (signal?.aborted) return cancel();
	if (reviews.length === 0) {
		return incomplete(
			"missing-review",
			"at least one completed Review Round response is required",
		);
	}
	try {
		await getControl("finalization", 1, finalizationControl);
		await collectContribution(
			"recommendation",
			chair,
			visibleContent(),
			(content) =>
				validateRecommendation(content, participants, contributions()),
		);
	} catch (error) {
		if (signal?.aborted) return cancel();
		return incomplete(
			"chair-failure",
			error instanceof Error ? error.message : "Chair finalization failed",
		);
	}
	deliberation.outcome = { kind: "recommendation" };
	deliberation.completedAt = now();
	return events;
}

function sessionsDirectory(directory: string) {
	return path.join(directory, "sessions");
}

function sessionFile(directory: string, id: string) {
	if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid Session ID");
	return path.join(sessionsDirectory(directory), `${id}.json`);
}

async function assertSessionDirectory(directory: string) {
	const directoryInfo = await lstat(sessionsDirectory(directory));
	if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
		throw new Error("Session directory must be a regular directory");
	}
}

async function assertSessionFile(file: string) {
	const fileInfo = await lstat(file);
	if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
		throw new Error("Session file must be a regular file");
	}
}

function parseSession(value: string): Session {
	const session = JSON.parse(value) as Session;
	if (session.version !== 1) {
		throw new Error(
			`Unsupported Session schema version ${String(session.version)}`,
		);
	}
	for (const deliberation of session.deliberations) {
		deliberation.providerSessionReferences ??= {};
	}
	return session;
}

async function repairSessionPermissions(directory: string, file: string) {
	await assertSessionDirectory(directory);
	await assertSessionFile(file);
	await chmod(sessionsDirectory(directory), 0o700);
	await chmod(file, 0o600);
}

export async function saveSession(
	directory: string,
	session: Session,
): Promise<void> {
	const destination = sessionsDirectory(directory);
	await mkdir(destination, { recursive: true, mode: 0o700 });
	await assertSessionDirectory(directory);
	await chmod(destination, 0o700);
	const file = sessionFile(directory, session.id);
	const temporaryFile = `${file}.${randomUUID()}.tmp`;
	await writeFile(temporaryFile, `${JSON.stringify(session, null, "\t")}\n`, {
		mode: 0o600,
	});
	await chmod(temporaryFile, 0o600);
	await rename(temporaryFile, file);
	await chmod(file, 0o600);
}

export async function loadSession(
	directory: string,
	id: string,
): Promise<Session> {
	const file = sessionFile(directory, id);
	await assertSessionDirectory(directory);
	await assertSessionFile(file);
	const session = parseSession(await readFile(file, "utf8"));
	await repairSessionPermissions(directory, file);
	return session;
}

export async function removeSession(
	directory: string,
	id: string,
): Promise<void> {
	await unlink(sessionFile(directory, id));
}

export type SessionMetadata = Pick<
	Session,
	"id" | "version" | "startedAt" | "workingDirectory"
> & {
	councilName: string;
	deliberationCount: number;
	latestQuestion?: string;
};

export async function loadSessionMetadata(
	directory: string,
): Promise<SessionMetadata[]> {
	let files: string[];
	try {
		await assertSessionDirectory(directory);
		files = (await readdir(sessionsDirectory(directory))).filter((file) =>
			file.endsWith(".json"),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return Promise.all(
		files.sort().map(async (file) => {
			const sessionFilePath = path.join(sessionsDirectory(directory), file);
			await assertSessionFile(sessionFilePath);
			const session = parseSession(await readFile(sessionFilePath, "utf8"));
			if (sessionFile(directory, session.id) !== sessionFilePath) {
				throw new Error("Session file identity does not match its record");
			}
			await repairSessionPermissions(directory, sessionFilePath);
			return {
				id: session.id,
				version: session.version,
				startedAt: session.startedAt,
				workingDirectory: session.workingDirectory,
				councilName: session.council.name,
				deliberationCount: session.deliberations.length,
				latestQuestion: session.deliberations.at(-1)?.question,
			};
		}),
	);
}
