import { Badge, Select, StatusMessage } from "@inkjs/ui";
import { Box, Text, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import { TextArea, type TextAreaHandle } from "react-ink-textarea";
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
import {
	createSession,
	loadSession,
	loadSessionMetadata,
	removeSession,
	runDeliberation,
	saveSession,
	type Session,
	type SessionMetadata,
} from "./session.js";

const memberStyle: Record<string, { color: string; glyph: string }> = {
	Chair: { color: "yellow", glyph: "◆" },
	Researcher: { color: "cyan", glyph: "●" },
	Critic: { color: "magenta", glyph: "▲" },
	Prototyper: { color: "green", glyph: "■" },
};

function Roster({
	members,
	statuses,
}: {
	members: Member[];
	statuses: Record<string, "waiting" | "working" | "completed" | "failed">;
}) {
	return (
		<Box
			flexDirection="column"
			width={36}
			paddingX={1}
			borderStyle="single"
			borderColor="gray"
		>
			<Text bold color="yellow">
				COUNCIL ROSTER
			</Text>
			{members.map((member) => {
				const style = memberStyle[member.role] ?? {
					color: "white",
					glyph: "●",
				};
				return (
					<Box key={member.handle} marginRight={1}>
						<Text color={style.color}>
							{style.glyph} {member.role}{" "}
						</Text>
						<Badge color="white">{statuses[member.handle] ?? "waiting"}</Badge>
					</Box>
				);
			})}
		</Box>
	);
}

function sessionLabel(session: SessionMetadata) {
	const context = session.latestQuestion
		? `Latest: ${session.latestQuestion}`
		: "No Deliberations";
	return `${session.councilName} · ${session.workingDirectory} · ${session.startedAt} · ${session.deliberationCount} Deliberation(s) · ${context}`;
}

function CouncilScreen({
	workingDirectory,
	configuration,
	configurationDirectory,
	recentSessions,
	onReloadConfiguration,
	onReloadSessions,
	onOpenConfiguration,
}: {
	workingDirectory: string;
	configuration?: Configuration;
	configurationDirectory: string;
	recentSessions: SessionMetadata[];
	onReloadConfiguration: () => Promise<ResolvedConfiguration>;
	onReloadSessions: () => Promise<SessionMetadata[]>;
	onOpenConfiguration: (file: string) => Promise<void>;
}) {
	const { columns } = useWindowSize();
	const [draft, setDraft] = useState("");
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
	const [statuses, setStatuses] = useState<
		Record<string, "waiting" | "working" | "completed" | "failed">
	>({});
	const textareaRef = useRef<TextAreaHandle>(null);
	const narrow = columns < 72;
	const council =
		session?.council ??
		(picker?.kind === "new"
			? picker.configuration.configuration
			: configuration
		)?.councils[0];
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
		} catch (error) {
			setError(
				error instanceof Error ? error.message : "Could not start Session",
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
		} catch (error) {
			setError(
				error instanceof Error ? error.message : "Could not resume Session",
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
		} catch (error) {
			setError(
				error instanceof Error ? error.message : "Could not remove Session",
			);
		}
	};
	const submit = async () => {
		const question = draft.trim();
		setDraft("");
		if (question === "/new") {
			try {
				setPicker({
					kind: "new",
					configuration: await onReloadConfiguration(),
				});
				setError(undefined);
			} catch (error) {
				setError(
					error instanceof Error
						? error.message
						: "Could not load configuration",
				);
			}
			return;
		}
		if (question === "/resume") {
			if (recentSessions.length === 0) {
				setNotice("No saved Sessions are available.");
				return;
			}
			setPicker({ kind: "resume" });
			setError(undefined);
			return;
		}
		if (question === "/remove") {
			if (recentSessions.length === 0) {
				setNotice("No saved Sessions are available.");
				return;
			}
			setPicker({ kind: "remove" });
			setError(undefined);
			return;
		}
		if (question === "/config") {
			setNotice(`Configuration: ${configurationPath(configurationDirectory)}`);
			setError(undefined);
			return;
		}
		if (question === "/config open") {
			const file = configurationPath(configurationDirectory);
			try {
				await onOpenConfiguration(file);
				setNotice(`Opened configuration: ${file}`);
				setError(undefined);
			} catch (error) {
				setError(
					`Could not open configuration at ${file}: ${error instanceof Error ? error.message : "unknown error"}`,
				);
			}
			return;
		}
		if (!question) return;
		if (!session) {
			setError("Start a new Session with /new.");
			return;
		}
		try {
			setBusy(true);
			await runDeliberation(session, question, {
				onEvent: (event) => {
					if (event.kind === "member-status") {
						setStatuses((current) => ({
							...current,
							[event.member]: event.status,
						}));
					} else {
						setSession({ ...session });
					}
				},
			});
			await saveSession(configurationDirectory, session);
			setSession({ ...session });
			setError(undefined);
		} catch (error) {
			setError(
				error instanceof Error ? error.message : "Could not run Deliberation",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Box flexDirection="column" width="100%">
			<Box justifyContent="space-between" flexWrap="wrap">
				<Text bold color="yellow">
					OpenAgentCouncil
				</Text>
				<Text dimColor>{workingDirectory}</Text>
			</Box>
			<Box
				flexDirection={narrow ? "column" : "row"}
				borderStyle="round"
				borderColor="gray"
				marginY={1}
			>
				{council && <Roster members={council.members} statuses={statuses} />}
				<Box flexDirection="column" flexGrow={1} paddingX={1}>
					<Text bold color="blue">
						MESSAGE THE COUNCIL
					</Text>
					{picker?.kind === "new" ? (
						<Box flexDirection="column">
							<Text>Choose a Council for this new Session.</Text>
							<Select
								options={picker.configuration.configuration.councils.map(
									(council) => ({
										label: council.name,
										value: council.name,
									}),
								)}
								onChange={(name) => {
									const selectedCouncil =
										picker.configuration.configuration.councils.find(
											(council) => council.name === name,
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
								options={recentSessions.map((session) => ({
									label: sessionLabel(session),
									value: session.id,
								}))}
								onChange={(id) => void resumeSession(id)}
							/>
						</Box>
					) : picker?.kind === "remove" ? (
						<Box flexDirection="column">
							<Text>Choose a saved Session to remove.</Text>
							<Select
								options={recentSessions.map((session) => ({
									label: sessionLabel(session),
									value: session.id,
								}))}
								onChange={(id) => {
									setSessionToRemove(
										recentSessions.find((session) => session.id === id),
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
						<TextArea
							ref={textareaRef}
							focus
							value={draft}
							onChange={setDraft}
							onSubmit={() => void submit()}
							placeholder="Type /new to start a Session, then ask a concrete question"
							initialLineCount={2}
							viewportLines={4}
							disableCursorBlink
							linePrefix={<Text color="cyan">❯ </Text>}
						/>
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
					{session?.timeline
						.filter((entry) => entry.kind !== "question")
						.map((entry) => (
							<Text
								key={`${entry.deliberationId}-${entry.kind}-${"member" in entry ? entry.member : ""}-${entry.createdAt}-${entry.content}`}
							>
								{entry.kind}: {entry.content}
							</Text>
						))}
					{error && <StatusMessage variant="error">{error}</StatusMessage>}
					{notice && <Text>{notice}</Text>}
				</Box>
			</Box>
		</Box>
	);
}

type AppProps = {
	workingDirectory: string;
	configurationDirectory?: string;
	availableProviders?: Provider[];
	pathValue?: string;
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
	if (providers.length === 0) {
		return (
			<StatusMessage variant="error">
				Install Codex or Claude Code, then run OpenAgentCouncil again.
			</StatusMessage>
		);
	}
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
						.catch((error: unknown) =>
							setError(error instanceof Error ? error.message : "Setup failed"),
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
	openConfiguration: openConfigurationOverride,
}: AppProps) {
	const [directory] = useState(
		() => configurationDirectory ?? defaultConfigurationDirectory(),
	);
	const [providers] = useState(
		() => availableProviders ?? detectProviders(pathValue),
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
				) {
					setError(
						configurationResult.reason instanceof Error
							? configurationResult.reason.message
							: "Could not load configuration",
					);
				}
			})
			.finally(() => setLoading(false));
	}, [directory, providers]);

	if (loading) return <Text>Loading OpenAgentCouncil…</Text>;
	if (error) return <StatusMessage variant="error">{error}</StatusMessage>;
	if (configuration || recentSessions.length > 0) {
		return (
			<CouncilScreen
				workingDirectory={workingDirectory}
				configuration={configuration}
				configurationDirectory={directory}
				recentSessions={recentSessions}
				onReloadConfiguration={reloadConfiguration}
				onReloadSessions={reloadSessions}
				onOpenConfiguration={openConfigurationOverride ?? openConfiguration}
			/>
		);
	}
	return (
		<Setup
			directory={directory}
			providers={providers}
			onComplete={setConfiguration}
		/>
	);
}
