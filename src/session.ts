import { randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	readdir,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Council, Member, Provider } from "./configuration.js";

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
type IncompleteReason = "missing-quorum" | "missing-review" | "chair-failure";

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

export type CouncilRequest = {
	phase: CouncilPhase;
	member: SessionMember;
	question: string;
	priorContent: string[];
	workingDirectory: string;
	providerSessionReference?: string;
	signal?: AbortSignal;
	onPartial: () => void;
};

type CouncilControlRequest = {
	phase: "round" | "finalization";
	chair: SessionMember;
	members: SessionMember[];
	question: string;
	round: number;
	priorContent: string[];
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
	control(request: CouncilControlRequest): string | Promise<string>;
	respond(
		request: CouncilRequest,
	): string | CouncilResponse | Promise<string | CouncilResponse>;
};

const deliberationBudget = { openRounds: 2, providerCalls: 20 } as const;

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

function roundControl(control: string, participants: SessionMember[]) {
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
		return [];
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
	return members as string[];
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

export async function runDeliberation(
	session: Session,
	question: string,
	{
		adapter = deterministicFakeAdapter,
		now = () => new Date().toISOString(),
		onEvent,
		signal,
	}: {
		adapter?: CouncilAdapter;
		now?: () => string;
		onEvent?: (event: RuntimeEvent) => void;
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
	session.timeline.push({
		kind: "question",
		deliberationId: deliberation.id,
		content: question,
		createdAt: deliberation.startedAt,
	});

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
	const call = async <T>(operation: () => T | Promise<T>): Promise<T> => {
		signal?.throwIfAborted();
		if (providerCalls >= deliberationBudget.providerCalls) {
			throw new Error("Deliberation provider-call budget exhausted");
		}
		providerCalls += 1;
		return operation();
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
		contributions().map(
			(entry) => `@${entry.member} (${entry.kind}):\n${entry.content}`,
		);
	const collectContribution = async (
		kind: CouncilPhase,
		member: SessionMember,
		priorContent: string[],
		validate?: (content: string) => void,
	) => {
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
			if (content.trim().length === 0) {
				throw new Error(`${kind} content must be non-empty`);
			}
			onPartial();
			validate?.(content);
			if (result.providerSessionReference) {
				deliberation.providerSessionReferences[member.handle] =
					result.providerSessionReference;
			}
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
	const getControl = async <Result>(
		phase: CouncilControlRequest["phase"],
		round: number,
		parse: (control: string) => Result,
	) => {
		let malformedControl: string | undefined;
		let validationError: string | undefined;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const control = await call(() =>
				adapter.control({
					phase,
					chair,
					members: session.council.members,
					question,
					round,
					priorContent: visibleContent(),
					malformedControl,
					validationError,
				}),
			);
			try {
				return parse(control);
			} catch (error) {
				if (attempt === 1) throw error;
				malformedControl = control as string;
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
	let control = await call(() => adapter.selectParticipants(selection));
	let handles: string[];
	try {
		handles = participantHandles(
			control,
			session.council.members,
			selection.requestedMembers,
		);
	} catch {
		control = await call(() =>
			adapter.selectParticipants({
				...selection,
				malformedControl: control,
			}),
		);
		handles = participantHandles(
			control,
			session.council.members,
			selection.requestedMembers,
		);
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
	signal?.throwIfAborted();
	if (new Set(positions.map((position) => position.member)).size < 2) {
		return incomplete(
			"missing-quorum",
			"Quorum requires two completed Positions",
		);
	}

	try {
		for (let round = 1; round <= deliberationBudget.openRounds; round += 1) {
			const roundMembers = await getControl("round", round, (value) =>
				roundControl(value, participants),
			);
			if (roundMembers.length === 0) break;
			const priorContent = visibleContent();
			await Promise.allSettled(
				roundMembers.map((handle) =>
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
