import { Badge, Select, StatusMessage } from "@inkjs/ui";
import { Box, Text, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import { TextArea, type TextAreaHandle } from "react-ink-textarea";
import {
	createEngineeringCouncil,
	defaultConfigurationDirectory,
	detectProviders,
	loadConfiguration,
	type Configuration,
	type Member,
	type Provider,
} from "./configuration.js";

const memberStyle: Record<Member["role"], { color: string; glyph: string }> = {
	Chair: { color: "yellow", glyph: "◆" },
	Researcher: { color: "cyan", glyph: "●" },
	Critic: { color: "magenta", glyph: "▲" },
	Prototyper: { color: "green", glyph: "■" },
};

function Roster({ members }: { members: Member[] }) {
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
				const style = memberStyle[member.role];
				return (
					<Box key={member.handle} marginRight={1}>
						<Text color={style.color}>
							{style.glyph} {member.role}{" "}
						</Text>
						<Badge color="white">waiting</Badge>
					</Box>
				);
			})}
		</Box>
	);
}

function CouncilScreen({
	workingDirectory,
	configuration,
}: {
	workingDirectory: string;
	configuration: Configuration;
}) {
	const { columns } = useWindowSize();
	const [draft, setDraft] = useState("");
	const textareaRef = useRef<TextAreaHandle>(null);
	const narrow = columns < 72;
	const council = configuration.councils[0];
	if (!council) return null;

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
				<Roster members={council.members} />
				<Box flexDirection="column" flexGrow={1} paddingX={1}>
					<Text bold color="blue">
						MESSAGE THE COUNCIL
					</Text>
					<TextArea
						ref={textareaRef}
						focus
						value={draft}
						onChange={setDraft}
						onSubmit={() => setDraft("")}
						placeholder="Message the Council, @mention a member, or type a command"
						initialLineCount={2}
						viewportLines={4}
						disableCursorBlink
						linePrefix={<Text color="cyan">❯ </Text>}
					/>
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
}: AppProps) {
	const [directory] = useState(
		() => configurationDirectory ?? defaultConfigurationDirectory(),
	);
	const [providers] = useState(
		() => availableProviders ?? detectProviders(pathValue),
	);
	const [configuration, setConfiguration] = useState<Configuration>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string>();

	useEffect(() => {
		loadConfiguration(directory, providers)
			.then(setConfiguration)
			.catch((error: unknown) => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					setError(
						error instanceof Error
							? error.message
							: "Could not load configuration",
					);
				}
			})
			.finally(() => setLoading(false));
	}, [directory, providers]);

	if (loading) return <Text>Loading OpenAgentCouncil…</Text>;
	if (error) return <StatusMessage variant="error">{error}</StatusMessage>;
	if (configuration) {
		return (
			<CouncilScreen
				workingDirectory={workingDirectory}
				configuration={configuration}
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
