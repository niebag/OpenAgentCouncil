import { accessSync, constants } from "node:fs";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type Provider = "codex" | "claude";

export type Member = {
	handle: string;
	role: string;
	provider: Provider;
	profile: string;
	model?: string;
	reasoningEffort?: string;
	capabilities?: "web"[];
};

export type Configuration = {
	version: 1;
	councils: Council[];
};

export type Council = { name: string; members: Member[] };

const configurationFile = "council.json";

export function configurationPath(directory: string) {
	return path.join(directory, configurationFile);
}

export function openConfiguration(file: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const command = process.platform === "darwin" ? "open" : "xdg-open";
		const child = spawn(command, [file], { stdio: "ignore", detached: true });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

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

function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	return string(value, name);
}

class ConfigurationError extends Error {
	constructor(
		errors: string[],
		readonly configuration?: Configuration,
	) {
		super(errors.join("\n"));
	}
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

	const errors: string[] = [];
	const councils = configuration.councils.flatMap((value, councilIndex) => {
		const council = asRecord(value, `Council ${councilIndex + 1}`);
		if (!Array.isArray(council.members)) {
			throw new Error(
				`Council ${councilIndex + 1} must include Council Members`,
			);
		}
		const members = council.members.flatMap((value, memberIndex) => {
			const member = asRecord(value, `Council Member ${memberIndex + 1}`);
			const handle = string(member.handle, "Member Handle");
			const label = `Council ${councilIndex + 1}, Member ${handle}`;
			const provider = string(member.provider, "Provider");
			const normalizedProvider: Provider =
				provider === "claude" ? "claude" : "codex";
			if (provider !== "codex" && provider !== "claude") {
				errors.push(`${label}: provider must be codex or claude`);
			}
			if (
				(provider === "codex" || provider === "claude") &&
				!availableProviders.includes(provider)
			) {
				errors.push(`${label}: provider ${provider} is unavailable`);
			}
			const profile = string(member.profile, "Member Profile");
			if (path.isAbsolute(profile) || profile.split(path.sep).includes("..")) {
				errors.push(
					`${label}: Member Profile must stay within the configuration directory`,
				);
			}
			if (!profile.endsWith(".md")) {
				errors.push(`${label}: Member Profile must be Markdown (.md)`);
			}
			const role = string(member.role, "Role");
			const capabilities = member.capabilities;
			if (
				capabilities !== undefined &&
				(!Array.isArray(capabilities) ||
					capabilities.some((capability) => capability !== "web"))
			) {
				errors.push(`${label}: capabilities may only include web`);
			}
			return [
				{
					handle,
					role,
					provider: normalizedProvider,
					profile,
					model: optionalString(member.model, "Model"),
					reasoningEffort: optionalString(
						member.reasoningEffort,
						"Reasoning effort",
					),
					capabilities: capabilities as Member["capabilities"],
				},
			];
		});
		if (members.filter((member) => member.role === "Chair").length !== 1) {
			errors.push(`Council ${councilIndex + 1}: exactly one Chair is required`);
		}
		if (members.filter((member) => member.role !== "Chair").length < 2) {
			errors.push(
				`Council ${councilIndex + 1}: at least two non-Chair Council Members are required`,
			);
		}
		if (
			new Set(members.map((member) => member.handle)).size !== members.length
		) {
			errors.push(`Council ${councilIndex + 1}: duplicate Member Handle`);
		}
		const name = string(council.name, "Council name");
		if (
			name === "Engineering Council" &&
			!["Chair", "Researcher", "Critic", "Prototyper"].every(
				(role) => members.filter((member) => member.role === role).length === 1,
			)
		) {
			errors.push(
				"Engineering Council requires Chair, Researcher, Critic, and Prototyper",
			);
		}
		return [{ name, members }];
	});

	const result = { version: 1 as const, councils };
	if (errors.length > 0) throw new ConfigurationError(errors, result);
	return result;
}

export type ResolvedConfiguration = {
	configuration: Configuration;
	profileContents: Record<string, string>;
};

export async function loadResolvedConfiguration(
	directory: string,
	availableProviders: readonly Provider[],
): Promise<ResolvedConfiguration> {
	let configuration: Configuration;
	const errors: string[] = [];
	try {
		configuration = validateConfiguration(
			JSON.parse(
				await readFile(path.join(directory, configurationFile), "utf8"),
			),
			availableProviders,
		);
	} catch (error) {
		if (!(error instanceof ConfigurationError) || !error.configuration)
			throw error;
		configuration = error.configuration;
		errors.push(error.message);
	}
	const profiles = configuration.councils.flatMap((council) => council.members);
	const results = await Promise.allSettled(
		profiles.map((member) =>
			path.isAbsolute(member.profile) ||
			member.profile.split(path.sep).includes("..")
				? Promise.resolve("")
				: readFile(path.resolve(directory, member.profile), "utf8"),
		),
	);
	errors.push(
		...results.flatMap((result, index) =>
			result.status === "rejected"
				? [
						`Member ${profiles[index]?.handle} Member Profile: ${result.reason.message}`,
					]
				: [],
		),
	);
	if (errors.length > 0) throw new ConfigurationError(errors);
	return {
		configuration,
		profileContents: Object.fromEntries(
			profiles.map((member, index) => [
				member.profile,
				(results[index] as PromiseFulfilledResult<string>).value,
			]),
		),
	};
}

export async function loadConfiguration(
	directory: string,
	availableProviders: readonly Provider[],
): Promise<Configuration> {
	return (await loadResolvedConfiguration(directory, availableProviders))
		.configuration;
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
