import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { DEFAULT_CONFIG } from "./defaults.ts";
import type { SandboxConfig, SandboxMode } from "../types.ts";

interface PartialConfig {
	mode?: unknown;
	workspaceRoot?: unknown;
	network?: { allow?: unknown };
	environment?: { allow?: unknown };
	filesystem?: { denyRead?: unknown };
}

async function readConfig(path: string): Promise<PartialConfig | undefined> {
	try {
		const value = parse(await readFile(path, "utf8"));
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("root must be a mapping");
		return value as PartialConfig;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Invalid sandbox config ${path}: ${(error as Error).message}`);
	}
}

function strings(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${field} must be a string array`);
	return [...new Set(value)];
}

function normalizeMode(value: unknown): SandboxMode | undefined {
	if (value === undefined) return undefined;
	if (value !== "dev" && value !== "off") throw new Error("mode must be dev or off");
	return value;
}

export function mergeConfig(global: PartialConfig | undefined, project: PartialConfig | undefined): SandboxConfig {
	const globalAllow = strings(global?.network?.allow, "network.allow") ?? DEFAULT_CONFIG.network.allow;
	const projectAllow = strings(project?.network?.allow, "network.allow");
	const effectiveAllow = projectAllow ? globalAllow.filter((host) => projectAllow.includes(host)) : globalAllow;
	const globalEnv = strings(global?.environment?.allow, "environment.allow") ?? DEFAULT_CONFIG.environment.allow;
	const projectEnv = strings(project?.environment?.allow, "environment.allow");
	const effectiveEnv = projectEnv ? globalEnv.filter((name) => projectEnv.includes(name)) : globalEnv;
	const denyRead = [...new Set([
		...DEFAULT_CONFIG.filesystem.denyRead,
		...(strings(global?.filesystem?.denyRead, "filesystem.denyRead") ?? []),
		...(strings(project?.filesystem?.denyRead, "filesystem.denyRead") ?? []),
	])];

	return {
		mode: normalizeMode(global?.mode) ?? DEFAULT_CONFIG.mode,
		workspaceRoot: typeof global?.workspaceRoot === "string" ? global.workspaceRoot : DEFAULT_CONFIG.workspaceRoot,
		network: { allow: effectiveAllow },
		environment: { allow: effectiveEnv },
		filesystem: { denyRead },
	};
}

export async function loadConfig(cwd: string, projectTrusted: boolean): Promise<SandboxConfig> {
	const globalConfig = await readConfig(join(homedir(), ".pi", "agent", "sandbox.yaml"));
	const projectConfig = projectTrusted ? await readConfig(join(cwd, ".pi", "sandbox.yaml")) : undefined;
	return mergeConfig(globalConfig, projectConfig);
}
