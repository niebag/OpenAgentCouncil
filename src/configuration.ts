import { accessSync, constants } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type Provider = "codex" | "claude";

export type Member = {
	handle: string;
	role: "Chair" | "Researcher" | "Critic" | "Prototyper";
	provider: Provider;
	profile: string;
};

export type Configuration = {
	version: 1;
	councils: Council[];
};

export type Council = { name: string; members: Member[] };

const configurationFile = "council.json";

export function defaultConfigurationDirectory(platform = process.platform) {
	return platform === "darwin"
		? path.join(homedir(), "Library", "Application Support", "OpenAgentCouncil")
		: path.join(
				process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"),
				"openagentcouncil",
			);
}

export function detectProviders(pathValue = process.env.PATH): Provider[] {
	const directories = pathValue?.split(path.delimiter) ?? [];
	return (["codex", "claude"] as const).filter((provider) =>
		directories.some((directory) => {
			try {
				accessSync(path.join(directory, provider), constants.X_OK);
				return true;
			} catch {
				return false;
			}
		}),
	);
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${name} must be a non-empty string`);
	}
	return value;
}

export function validateConfiguration(
	value: unknown,
	availableProviders: readonly Provider[],
): Configuration {
	const configuration = asRecord(value, "Configuration");
	if (configuration.version !== 1 || !Array.isArray(configuration.councils)) {
		throw new Error("Configuration must use version 1 and include Councils");
	}
	if (configuration.councils.length === 0) {
		throw new Error("Configuration must include a Council");
	}

	const councils = configuration.councils.map((value, councilIndex) => {
		const council = asRecord(value, `Council ${councilIndex + 1}`);
		if (!Array.isArray(council.members)) {
			throw new Error(
				`Council ${councilIndex + 1} must include Council Members`,
			);
		}
		const members = council.members.map((value, memberIndex) => {
			const member = asRecord(value, `Council Member ${memberIndex + 1}`);
			const provider = string(member.provider, "Provider");
			if (provider !== "codex" && provider !== "claude") {
				throw new Error(
					`Council Member ${memberIndex + 1} has an unsupported provider`,
				);
			}
			if (!availableProviders.includes(provider)) {
				throw new Error(
					`Council Member ${memberIndex + 1} requires unavailable ${provider}`,
				);
			}
			const profile = string(member.profile, "Member Profile");
			if (path.isAbsolute(profile) || profile.split(path.sep).includes("..")) {
				throw new Error(
					`Council Member ${memberIndex + 1} has an invalid Member Profile path`,
				);
			}
			const role = string(member.role, "Role");
			if (!["Chair", "Researcher", "Critic", "Prototyper"].includes(role)) {
				throw new Error(
					`Council Member ${memberIndex + 1} has an invalid role`,
				);
			}
			return {
				handle: string(member.handle, "Member Handle"),
				role,
				provider,
				profile,
			} as Member;
		});
		if (members.filter((member) => member.role === "Chair").length !== 1) {
			throw new Error("A Council must have exactly one Chair");
		}
		if (members.filter((member) => member.role !== "Chair").length < 2) {
			throw new Error("A Council needs at least two non-Chair Council Members");
		}
		if (
			new Set(members.map((member) => member.handle)).size !== members.length
		) {
			throw new Error("Council Member Handles must be unique");
		}
		const name = string(council.name, "Council name");
		if (
			name === "Engineering Council" &&
			!["Chair", "Researcher", "Critic", "Prototyper"].every(
				(role) => members.filter((member) => member.role === role).length === 1,
			)
		) {
			throw new Error(
				"Engineering Council requires Chair, Researcher, Critic, and Prototyper",
			);
		}
		return { name, members };
	});

	return { version: 1, councils };
}

export async function loadConfiguration(
	directory: string,
	availableProviders: readonly Provider[],
): Promise<Configuration> {
	const configuration = validateConfiguration(
		JSON.parse(await readFile(path.join(directory, configurationFile), "utf8")),
		availableProviders,
	);
	await Promise.all(
		configuration.councils.flatMap((council) =>
			council.members.map((member) =>
				readFile(path.join(directory, member.profile), "utf8"),
			),
		),
	);
	return configuration;
}

export async function createEngineeringCouncil(
	directory: string,
	provider: Provider,
): Promise<Configuration> {
	const members: Member[] = [
		["chair", "Chair"],
		["researcher", "Researcher"],
		["critic", "Critic"],
		["prototyper", "Prototyper"],
	].map(([handle, role]) => ({
		handle,
		role: role as Member["role"],
		provider,
		profile: `profiles/${handle}.md`,
	}));
	const configuration: Configuration = {
		version: 1,
		councils: [{ name: "Engineering Council", members }],
	};
	await mkdir(path.join(directory, "profiles"), {
		recursive: true,
		mode: 0o700,
	});
	await Promise.all(
		members.map((member) =>
			writeFile(
				path.join(directory, member.profile),
				`# ${member.role}\n\nYou are the Engineering Council ${member.role}.\n`,
				{ mode: 0o600 },
			),
		),
	);
	const file = path.join(directory, configurationFile);
	const temporaryFile = `${file}.tmp`;
	await writeFile(
		temporaryFile,
		`${JSON.stringify(configuration, null, "\t")}\n`,
		{
			mode: 0o600,
		},
	);
	await chmod(temporaryFile, 0o600);
	await rename(temporaryFile, file);
	return configuration;
}
