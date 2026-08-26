import { Badge } from "@inkjs/ui";
import { Box, Text, useWindowSize } from "ink";
import { useRef, useState } from "react";
import { TextArea, type TextAreaHandle } from "react-ink-textarea";

const members = [
	{
		handle: "chair",
		label: "Chair",
		role: "Chair",
		color: "yellow",
		glyph: "◆",
	},
	{
		handle: "researcher",
		label: "Researcher",
		role: "Evidence",
		color: "cyan",
		glyph: "●",
	},
	{
		handle: "critic",
		label: "Critic",
		role: "Challenge",
		color: "magenta",
		glyph: "▲",
	},
	{
		handle: "prototyper",
		label: "Prototyper",
		role: "Runnable proof",
		color: "green",
		glyph: "■",
	},
] as const;

function Roster() {
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
			{members.map((member) => (
				<Box key={member.handle} marginRight={1}>
					<Text color={member.color}>
						{member.glyph} {member.label}{" "}
					</Text>
					<Badge color="white">waiting</Badge>
				</Box>
			))}
		</Box>
	);
}

export function App({ workingDirectory }: { workingDirectory: string }) {
	const { columns } = useWindowSize();
	const [draft, setDraft] = useState("");
	const textareaRef = useRef<TextAreaHandle>(null);
	const narrow = columns < 72;

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
				<Roster />
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
