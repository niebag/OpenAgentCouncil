import { Badge, Select, StatusMessage } from "@inkjs/ui";
import { Box, Static, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	TextArea,
	type TLabels,
	type TextAreaHandle,
} from "react-ink-textarea";
import {
	configurationPath,
	createEngineeringCouncil,
	defaultConfigurationDirectory,
	detectProviders,
	loadConfiguration,
	loadResolvedConfiguration,
	openConfiguration,
	type Configuration,
	type Member,
	type Provider,
	type ResolvedConfiguration,
} from "./configuration.js";
import { createCodexCouncilAdapter } from "./codex.js";
import {
	createSession,
	loadSession,
	loadSessionMetadata,
	removeSession,
	runDeliberation,
	saveSession,
	type CouncilAdapter,
	type Session,
	type SessionMetadata,
} from "./session.js";

type MemberStatus =
	| "waiting"
	| "thinking"
	| "researching"
	| "typing"
	| "done"
	| "failed";
type TranscriptMessage = {
	id: string;
	author: "user" | "system" | string;
	content: string;
	createdAt: string;
};

const commands = [
	"/new",
	"/resume",
	"/stop",
	"/members",
	"/help",
	"/config",
	"/config open",
	"/quit",
] as const;
const memberStyle: Record<string, { color: string; glyph: string }> = {
	Chair: { color: "yellow", glyph: "◆" },
	Researcher: { color: "cyan", glyph: "●" },
	Critic: { color: "magenta", glyph: "▲" },
	Prototyper: { color: "green", glyph: "■" },
};
const statusColor: Record<MemberStatus, string> = {
	waiting: "white",
	thinking: "blue",
	researching: "cyan",
	typing: "yellow",
	done: "green",
	failed: "red",
};

function memberPresentation(member: Member) {
	return memberStyle[member.role] ?? { color: "white", glyph: "●" };
}

function formatMessageTime(createdAt: string) {
	const value = new Date(createdAt);
	return Number.isNaN(value.valueOf())
		? ""
		: value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function timelineMessages(session?: Session): TranscriptMessage[] {
	if (!session) return [];
	return session.timeline.map((entry) => ({
		id: `${entry.deliberationId}-${entry.kind}-${entry.createdAt}-${"member" in entry ? entry.member : "user"}`,
		author:
			entry.kind === "question"
				? "user"
				: "member" in entry
					? entry.member
					: "system",
		content: entry.content,
		createdAt: entry.createdAt,
	}));
}

function Roster({
	members,
	statuses,
	narrow,
}: {
	members: Member[];
	statuses: Record<string, MemberStatus>;
	narrow: boolean;
}) {
	return (
		<Box
			flexDirection="column"
			width={narrow ? "100%" : 36}
			paddingX={1}
			borderStyle="single"
			borderColor="gray"
		>
			<Text bold color="yellow">
				COUNCIL ROSTER
			</Text>
			{members.map((member) => {
				const style = memberPresentation(member);
				const status = statuses[member.handle] ?? "waiting";
				return (
					<Box key={member.handle} marginRight={1}>
						<Text color={style.color}>
							{style.glyph} {member.role} @{member.handle}{" "}
						</Text>
						<Badge color={statusColor[status]}>{status}</Badge>
					</Box>
				);
			})}
		</Box>
	);
}

function CompletedMessage({
	message,
	members,
	columns,
}: {
	message: TranscriptMessage;
	members: Member[];
	columns: number;
}) {
	const narrow = columns < 72;
	const user = message.author === "user";
	const member = members.find(
		(candidate) => candidate.handle === message.author,
	);
	const style = member
		? memberPresentation(member)
		: { color: "gray", glyph: "─" };
	const color = user ? "blue" : style.color;
	const label = user
		? "YOU"
		: member
			? `${style.glyph} ${member.role} @${member.handle}`
			: "SYSTEM";
	const width = narrow
		? Math.max(24, columns - 2)
		: Math.min(72, Math.floor(columns * 0.68));
	return (
		<Box
			width={columns}
			justifyContent={narrow || !user ? "flex-start" : "flex-end"}
			marginBottom={1}
		>
			<Box
				flexDirection="column"
				width={width}
				borderStyle="round"
				borderColor={color}
				paddingX={1}
			>
				<Box justifyContent="space-between">
					<Text bold color={color}>
						{label}
					</Text>
					<Text dimColor>{formatMessageTime(message.createdAt)}</Text>
				</Box>
				<Text wrap="wrap">{message.content}</Text>
			</Box>
		</Box>
	);
}

function sessionLabel(session: SessionMetadata) {
	const context = session.latestQuestion
		? `Latest: ${session.latestQuestion}`
		: "No Deliberations";
	return `${session.councilName} · ${session.workingDirectory} · ${session.startedAt} · ${session.deliberationCount} Deliberation(s) · ${context}`;
}

function cursorOffset(value: string, [line, column]: [number, number]) {
	return (
		value
			.split("\n")
			.slice(0, line)
			.reduce((offset, current) => offset + current.length + 1, 0) + column
	);
}

function completionToken(value: string, cursor: [number, number]) {
	return value
		.slice(0, cursorOffset(value, cursor))
		.match(/(?:^|\s)([@/][\w-]*)$/)?.[1]
		.toLowerCase();
}

function CouncilScreen({
	workingDirectory,
	configuration,
	configurationDirectory,
	recentSessions,
	adapter,
	onReloadConfiguration,
	onReloadSessions,
	onOpenConfiguration,
}: {
	workingDirectory: string;
	configuration?: Configuration;
	configurationDirectory: string;
	recentSessions: SessionMetadata[];
	adapter?: CouncilAdapter;
	onReloadConfiguration: () => Promise<ResolvedConfiguration>;
	onReloadSessions: () => Promise<SessionMetadata[]>;
	onOpenConfiguration: (file: string) => Promise<void>;
}) {
	const { exit } = useApp();
	const { columns } = useWindowSize();
	const [draft, setDraft] = useState("");
	const [cursor, setCursor] = useState<[number, number]>([0, 0]);
	const [session, setSession] = useState<Session>();
	const [picker, setPicker] = useState<
		| { kind: "new"; configuration: ResolvedConfiguration }
		| { kind: "resume" }
		| { kind: "remove" }
	>();
	const [sessionToRemove, setSessionToRemove] = useState<SessionMetadata>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState<string>();
	const [statuses, setStatuses] = useState<Record<string, MemberStatus>>({});
	const textareaRef = useRef<TextAreaHandle>(null);
	const runId = useRef(0);
	const abortController = useRef<AbortController | undefined>(undefined);
	useEffect(() => () => abortController.current?.abort(), []);
	const narrow = columns < 72;
	const council =
		session?.council ??
		(picker?.kind === "new"
			? picker.configuration.configuration
			: configuration
		)?.councils[0];
	const token = completionToken(draft, cursor);
	const suggestions = useMemo(() => {
		if (!token) return [];
		if (token.startsWith("@"))
			return (council?.members ?? [])
				.map((member) => `@${member.handle}`)
				.filter((handle) => handle.toLowerCase().startsWith(token));
		return commands.filter((command) => command.startsWith(token));
	}, [council?.members, token]);
	const labels: TLabels = useMemo(
		() => [
			{
				pattern: /@[a-z][\w-]*/gi,
				label: (match) =>
					council?.members.some(
						(member) =>
							member.handle.toLowerCase() === match[0].slice(1).toLowerCase(),
					)
						? "mention"
						: undefined,
			},
			{
				pattern: /\/[a-z][\w-]*/gi,
				label: (match) =>
					commands.some((command) => command === match[0].toLowerCase())
						? "command"
						: undefined,
			},
		],
		[council?.members],
	);
	const stop = (message = "Stopped active Deliberation.") => {
		abortController.current?.abort();
		setStatuses({});
		setNotice(message);
	};
	useInput((input, key) => {
		if (key.ctrl && input.toLowerCase() === "c") {
			stop("Cancelled active Deliberation.");
			exit();
		}
	});

	const startSession = async (
		selectedCouncil: Configuration["councils"][number],
		profileContents: Record<string, string>,
	) => {
		try {
			const nextSession = createSession({
				council: selectedCouncil,
				workingDirectory,
				profileContents,
			});
			await saveSession(configurationDirectory, nextSession);
			setSession(nextSession);
			setStatuses({});
			setPicker(undefined);
			setError(undefined);
			setNotice(undefined);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not start Session",
			);
		}
	};
	const resumeSession = async (id: string) => {
		try {
			setSession(await loadSession(configurationDirectory, id));
			setStatuses({});
			setPicker(undefined);
			setError(undefined);
			setNotice(undefined);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not resume Session",
			);
		}
	};
	const confirmRemove = async () => {
		if (!sessionToRemove) return;
		try {
			await removeSession(configurationDirectory, sessionToRemove.id);
			await onReloadSessions();
			setNotice(`Removed saved Session: ${sessionToRemove.councilName}`);
			setSessionToRemove(undefined);
			setError(undefined);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not remove Session",
			);
		}
	};
	const submit = async () => {
		const value = draft.trim();
		if (!value) return;
		setDraft("");
		setCursor([0, 0]);
		if (value === "/new") {
			try {
				setPicker({
					kind: "new",
					configuration: await onReloadConfiguration(),
				});
				setError(undefined);
			} catch (cause) {
				setError(
					cause instanceof Error
						? cause.message
						: "Could not load configuration",
				);
			}
			return;
		}
		if (value === "/resume") {
			if (recentSessions.length === 0)
				setNotice("No saved Sessions are available.");
			else {
				setPicker({ kind: "resume" });
				setError(undefined);
			}
			return;
		}
		if (value === "/remove") {
			if (recentSessions.length === 0)
				setNotice("No saved Sessions are available.");
			else {
				setPicker({ kind: "remove" });
				setError(undefined);
			}
			return;
		}
		if (value === "/stop") {
			stop();
			return;
		}
		if (value === "/members") {
			setNotice(
				(council?.members ?? [])
					.map((member) => `@${member.handle} (${member.role})`)
					.join(" · ") || "No Council is selected.",
			);
			return;
		}
		if (value === "/help") {
			setNotice(`Commands: ${commands.join(", ")}`);
			return;
		}
		if (value === "/quit") {
			stop("Goodbye.");
			exit();
			return;
		}
		if (value === "/config") {
			setNotice(`Configuration: ${configurationPath(configurationDirectory)}`);
			setError(undefined);
			return;
		}
		if (value === "/config open") {
			const file = configurationPath(configurationDirectory);
			try {
				await onOpenConfiguration(file);
				setNotice(`Opened configuration: ${file}`);
				setError(undefined);
			} catch (cause) {
				setError(
					`Could not open configuration at ${file}: ${cause instanceof Error ? cause.message : "unknown error"}`,
				);
			}
			return;
		}
		if (value.startsWith("/")) {
			setDraft(value);
			setCursor([0, value.length]);
			setError(`Unknown command: ${value.split(/\s/, 1)[0]}. Type /help.`);
			return;
		}
		if (busy) {
			setNotice("Waiting for the active Deliberation to stop.");
			return;
		}
		if (!session) {
			setDraft(value);
			setCursor([0, value.length]);
			setError("Start a new Session with /new.");
			return;
		}
		const currentRun = runId.current + 1;
		runId.current = currentRun;
		const timelineLength = session.timeline.length;
		const deliberationLength = session.deliberations.length;
		const controller = new AbortController();
		abortController.current = controller;
		setBusy(true);
		setError(undefined);
		const deliberation = runDeliberation(session, value, {
			adapter,
			signal: controller.signal,
			onEvent: (event) => {
				if (currentRun !== runId.current) return;
				if (event.kind === "member-status") {
					const member = session.council.members.find(
						(candidate) => candidate.handle === event.member,
					);
					setStatuses((current) => ({
						...current,
						[event.member]:
							event.status === "working"
								? member?.capabilities?.includes("web")
									? "researching"
									: "thinking"
								: event.status === "typing"
									? "typing"
									: event.status === "completed"
										? "done"
										: "failed",
					}));
				} else setSession({ ...session });
			},
		});
		setSession({ ...session });
		try {
			await deliberation;
			if (currentRun !== runId.current) return;
			await saveSession(configurationDirectory, session);
			if (currentRun !== runId.current) return;
			setSession({ ...session });
			setError(undefined);
		} catch (cause) {
			if (currentRun === runId.current && controller.signal.aborted) {
				session.timeline.splice(timelineLength);
				session.deliberations.splice(deliberationLength);
				setSession({ ...session });
			} else if (currentRun === runId.current)
				setError(
					cause instanceof Error ? cause.message : "Could not run Deliberation",
				);
		} finally {
			if (currentRun === runId.current) {
				abortController.current = undefined;
				setBusy(false);
			}
		}
	};
	const completeSuggestion = () => {
		const suggestion = suggestions[0];
		if (suggestion && token)
			textareaRef.current?.insert(`${suggestion.slice(token.length)} `);
	};

	return (
		<>
			<Static items={timelineMessages(session)}>
				{(message) => (
					<CompletedMessage
						key={message.id}
						message={message}
						members={session?.council.members ?? []}
						columns={columns}
					/>
				)}
			</Static>
			<Box flexDirection="column" width="100%">
				<Box justifyContent="space-between" flexWrap="wrap">
					<Text bold color="yellow">
						OpenAgentCouncil
					</Text>
					<Text dimColor>{workingDirectory}</Text>
				</Box>
				<Text dimColor>
					Tab completes · Enter sends · Ctrl+J adds a line · Ctrl+C quits
				</Text>
				<Box
					flexDirection={narrow ? "column" : "row"}
					borderStyle="round"
					borderColor="gray"
					marginY={1}
				>
					{council && (
						<Roster
							members={council.members}
							statuses={statuses}
							narrow={narrow}
						/>
					)}
					<Box flexDirection="column" flexGrow={1} paddingX={1}>
						<Text bold color="blue">
							MESSAGE THE COUNCIL
						</Text>
						{picker?.kind === "new" ? (
							<Box flexDirection="column">
								<Text>Choose a Council for this new Session.</Text>
								<Select
									options={picker.configuration.configuration.councils.map(
										(item) => ({ label: item.name, value: item.name }),
									)}
									onChange={(name) => {
										const selectedCouncil =
											picker.configuration.configuration.councils.find(
												(item) => item.name === name,
											);
										if (selectedCouncil)
											void startSession(
												selectedCouncil,
												picker.configuration.profileContents,
											);
									}}
								/>
							</Box>
						) : picker?.kind === "resume" ? (
							<Box flexDirection="column">
								<Text>Choose a saved Session to resume.</Text>
								<Select
									options={recentSessions.map((item) => ({
										label: sessionLabel(item),
										value: item.id,
									}))}
									onChange={(id) => void resumeSession(id)}
								/>
							</Box>
						) : picker?.kind === "remove" ? (
							<Box flexDirection="column">
								<Text>Choose a saved Session to remove.</Text>
								<Select
									options={recentSessions.map((item) => ({
										label: sessionLabel(item),
										value: item.id,
									}))}
									onChange={(id) => {
										setSessionToRemove(
											recentSessions.find((item) => item.id === id),
										);
										setPicker(undefined);
									}}
								/>
							</Box>
						) : sessionToRemove ? (
							<Box flexDirection="column">
								<Text>Remove this saved Session?</Text>
								<Text dimColor>{sessionLabel(sessionToRemove)}</Text>
								<Select
									options={[
										{ label: "Cancel", value: "cancel" },
										{ label: "Remove Session", value: "remove" },
									]}
									onChange={(choice) => {
										if (choice === "remove") void confirmRemove();
										else setSessionToRemove(undefined);
									}}
								/>
							</Box>
						) : (
							<Box flexDirection="column" width="100%">
								{suggestions.length > 0 && (
									<Box>
										<Text color="yellow">Tab to complete: </Text>
										{suggestions.slice(0, 4).map((suggestion, index) => (
											<Text
												key={suggestion}
												color={index === 0 ? "cyan" : "gray"}
											>
												{index > 0 ? "  " : ""}
												{suggestion}
											</Text>
										))}
									</Box>
								)}
								<TextArea
									ref={textareaRef}
									focus
									value={draft}
									cursorPosition={cursor}
									onChange={setDraft}
									onCursorChange={(position) => setCursor(position)}
									onSubmit={() => void submit()}
									onTab={completeSuggestion}
									placeholder="Message the Council, @mention a Member, or type /help"
									initialLineCount={2}
									viewportLines={4}
									disableCursorBlink
									linePrefix={<Text color="cyan">❯ </Text>}
									labels={labels}
									styles={{
										mention: { color: "cyan", bold: true },
										command: { color: "magenta", bold: true },
									}}
								/>
							</Box>
						)}
						{session && (
							<Text dimColor>Session started: {session.council.name}</Text>
						)}
						{busy && <Text color="yellow">Deliberating…</Text>}
						{recentSessions.length > 0 && !session && (
							<Text dimColor>
								{recentSessions.length} saved Session(s) available.
							</Text>
						)}
						{error && <StatusMessage variant="error">{error}</StatusMessage>}
						{notice && <Text>{notice}</Text>}
					</Box>
				</Box>
			</Box>
		</>
	);
}

type AppProps = {
	workingDirectory: string;
	configurationDirectory?: string;
	availableProviders?: Provider[];
	pathValue?: string;
	adapter?: CouncilAdapter;
	openConfiguration?: (file: string) => Promise<void>;
};

function Setup({
	directory,
	providers,
	onComplete,
}: {
	directory: string;
	providers: Provider[];
	onComplete: (configuration: Configuration) => void;
}) {
	const [error, setError] = useState<string>();
	if (providers.length === 0)
		return (
			<StatusMessage variant="error">
				Install Codex or Claude Code, then run OpenAgentCouncil again.
			</StatusMessage>
		);
	return (
		<Box flexDirection="column">
			<Text bold>Set up your Engineering Council</Text>
			<Text>Choose an installed CLI for its Council Members.</Text>
			<Select
				options={providers.map((provider) => ({
					label: provider === "codex" ? "Codex" : "Claude Code",
					value: provider,
				}))}
				onChange={(provider) => {
					createEngineeringCouncil(directory, provider as Provider)
						.then(onComplete)
						.catch((cause: unknown) =>
							setError(cause instanceof Error ? cause.message : "Setup failed"),
						);
				}}
			/>
			{error && <StatusMessage variant="error">{error}</StatusMessage>}
		</Box>
	);
}

export function App({
	workingDirectory,
	configurationDirectory,
	availableProviders,
	pathValue,
	adapter,
	openConfiguration: openConfigurationOverride,
}: AppProps) {
	const [directory] = useState(
		() => configurationDirectory ?? defaultConfigurationDirectory(),
	);
	const [providers] = useState(
		() => availableProviders ?? detectProviders(pathValue),
	);
	const [productionAdapter] = useState(() =>
		createCodexCouncilAdapter({ workingDirectory }),
	);
	const [configuration, setConfiguration] = useState<Configuration>();
	const [recentSessions, setRecentSessions] = useState<SessionMetadata[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string>();
	const reloadConfiguration = async () => {
		const resolved = await loadResolvedConfiguration(directory, providers);
		setConfiguration(resolved.configuration);
		return resolved;
	};
	const reloadSessions = async () => {
		const sessions = await loadSessionMetadata(directory);
		setRecentSessions(sessions);
		return sessions;
	};
	useEffect(() => {
		Promise.allSettled([
			loadConfiguration(directory, providers),
			loadSessionMetadata(directory),
		])
			.then(([configurationResult, sessionsResult]) => {
				if (sessionsResult.status === "rejected") {
					setError(
						sessionsResult.reason instanceof Error
							? sessionsResult.reason.message
							: "Could not load saved Sessions",
					);
					return;
				}
				setRecentSessions(sessionsResult.value);
				if (configurationResult.status === "fulfilled") {
					setConfiguration(configurationResult.value);
					return;
				}
				if (
					sessionsResult.value.length === 0 &&
					(configurationResult.reason as NodeJS.ErrnoException).code !==
						"ENOENT"
				)
					setError(
						configurationResult.reason instanceof Error
							? configurationResult.reason.message
							: "Could not load configuration",
					);
			})
			.finally(() => setLoading(false));
	}, [directory, providers]);
	if (loading) return <Text>Loading OpenAgentCouncil…</Text>;
	if (error) return <StatusMessage variant="error">{error}</StatusMessage>;
	if (configuration || recentSessions.length > 0)
		return (
			<CouncilScreen
				workingDirectory={workingDirectory}
				configuration={configuration}
				configurationDirectory={directory}
				recentSessions={recentSessions}
				adapter={adapter ?? productionAdapter}
				onReloadConfiguration={reloadConfiguration}
				onReloadSessions={reloadSessions}
				onOpenConfiguration={openConfigurationOverride ?? openConfiguration}
			/>
		);
	return (
		<Setup
			directory={directory}
			providers={providers}
			onComplete={setConfiguration}
		/>
	);
}
