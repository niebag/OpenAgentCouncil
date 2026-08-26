import { randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	readFile,
	readdir,
	rename,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Council, Member } from "./configuration.js";

type SessionMember = Member & { profileContent: string };

export type TimelineEntry =
	| {
			kind: "question";
			deliberationId: string;
			content: string;
			createdAt: string;
	  }
	| {
			kind: "position";
			deliberationId: string;
			member: string;
			content: string;
			createdAt: string;
	  }
	| {
			kind: "draft-recommendation";
			deliberationId: string;
			member: string;
			content: string;
			createdAt: string;
	  }
	| {
			kind: "review";
			deliberationId: string;
			member: string;
			content: string;
			createdAt: string;
	  }
	| {
			kind: "recommendation";
			deliberationId: string;
			member: string;
			content: string;
			createdAt: string;
	  };

export type Session = {
	version: 1;
	id: string;
	startedAt: string;
	workingDirectory: string;
	council: { name: string; members: SessionMember[] };
	deliberations: Array<{
		id: string;
		question: string;
		startedAt: string;
		completedAt?: string;
	}>;
	timeline: TimelineEntry[];
};

export type RuntimeEvent =
	| { kind: "member-status"; member: string; status: "working" | "completed" }
	| { kind: "content"; entry: Exclude<TimelineEntry, { kind: "question" }> };

type CouncilRequest = {
	phase: "position" | "draft-recommendation" | "review" | "recommendation";
	member: SessionMember;
	question: string;
	priorContent: string[];
};

export type CouncilAdapter = {
	selectParticipants(input: {
		chair: SessionMember;
		members: SessionMember[];
	}): string[];
	respond(request: CouncilRequest): string | Promise<string>;
};

export const deterministicFakeAdapter: CouncilAdapter = {
	selectParticipants({ members }) {
		const selected = members
			.filter(
				(member) => member.role === "Researcher" || member.role === "Critic",
			)
			.map((member) => member.handle);
		return selected.length >= 2
			? selected
			: members
					.filter((member) => member.role !== "Chair")
					.slice(0, 2)
					.map((member) => member.handle);
	},
	respond({ phase, member, question }) {
		const subject = `“${question}”`;
		if (phase === "position") return `${member.role} Position on ${subject}.`;
		if (phase === "draft-recommendation")
			return `Draft Recommendation for ${subject}.`;
		if (phase === "review") return `Review completed for ${subject}.`;
		return `Recommendation for ${subject}.`;
	},
};

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
	}: {
		adapter?: CouncilAdapter;
		now?: () => string;
		onEvent?: (event: RuntimeEvent) => void;
	} = {},
): Promise<RuntimeEvent[]> {
	const deliberation: Session["deliberations"][number] = {
		id: `deliberation-${session.deliberations.length + 1}`,
		question,
		startedAt: now(),
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
	const complete = async (
		kind: Exclude<TimelineEntry["kind"], "question">,
		member: SessionMember,
		priorContent: string[],
	) => {
		emit({ kind: "member-status", member: member.handle, status: "working" });
		const entry = {
			kind,
			deliberationId: deliberation.id,
			member: member.handle,
			content: await adapter.respond({
				phase: kind,
				member,
				question,
				priorContent,
			}),
			createdAt: now(),
		} as Exclude<TimelineEntry, { kind: "question" }>;
		session.timeline.push(entry);
		emit({ kind: "content", entry });
		emit({ kind: "member-status", member: member.handle, status: "completed" });
		return entry;
	};

	const chair = session.council.members.find(
		(member) => member.role === "Chair",
	);
	if (!chair) throw new Error("Council requires a Chair and Quorum");
	const participants = [
		...new Set(
			adapter.selectParticipants({ chair, members: session.council.members }),
		),
	]
		.map((handle) =>
			session.council.members.find((member) => member.handle === handle),
		)
		.filter(
			(member): member is SessionMember =>
				member !== undefined && member.role !== "Chair",
		);
	if (participants.length < 2)
		throw new Error("Council requires a Chair and Quorum");

	const positions = await Promise.all(
		participants.map((member) => complete("position", member, [])),
	);
	const draft = await complete(
		"draft-recommendation",
		chair,
		positions.map((position) => position.content),
	);
	const review = await complete("review", participants[0], [draft.content]);
	await complete("recommendation", chair, [draft.content, review.content]);
	deliberation.completedAt = now();
	return events;
}

function sessionsDirectory(directory: string) {
	return path.join(directory, "sessions");
}

export async function saveSession(
	directory: string,
	session: Session,
): Promise<void> {
	const destination = sessionsDirectory(directory);
	await mkdir(destination, { recursive: true, mode: 0o700 });
	const file = path.join(destination, `${session.id}.json`);
	const temporaryFile = `${file}.tmp`;
	await writeFile(temporaryFile, `${JSON.stringify(session, null, "\t")}\n`, {
		mode: 0o600,
	});
	await chmod(temporaryFile, 0o600);
	await rename(temporaryFile, file);
}

export type SessionMetadata = Pick<
	Session,
	"id" | "version" | "startedAt" | "workingDirectory"
> & { councilName: string };

export async function loadSessionMetadata(
	directory: string,
): Promise<SessionMetadata[]> {
	let files: string[];
	try {
		files = (await readdir(sessionsDirectory(directory))).filter((file) =>
			file.endsWith(".json"),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return Promise.all(
		files.sort().map(async (file) => {
			const session = JSON.parse(
				await readFile(path.join(sessionsDirectory(directory), file), "utf8"),
			) as Session;
			return {
				id: session.id,
				version: session.version,
				startedAt: session.startedAt,
				workingDirectory: session.workingDirectory,
				councilName: session.council.name,
			};
		}),
	);
}
