import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";
import { DEFAULT_CONFIG } from "./defaults.ts";
import type { CacheConfig, SandboxConfig, SandboxMode } from "../types.ts";

interface PartialConfig {
	mode?: unknown;
	workspaceRoot?: unknown;
	cacheRoot?: unknown;
	network?: { allow?: unknown };
	environment?: { allow?: unknown };
	filesystem?: { denyRead?: unknown };
	cache?: Partial<Record<keyof CacheConfig, unknown>>;
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

function mapping(value: unknown, field: string): void {
	if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) {
		throw new Error(`${field} must be a mapping`);
	}
}

function pathValue(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
	return value;
}

function validateConfig(config: PartialConfig | undefined): void {
	if (!config) return;
	mapping(config.network, "network");
	mapping(config.environment, "environment");
	mapping(config.filesystem, "filesystem");
	mapping(config.cache, "cache");
	pathValue(config.workspaceRoot, "workspaceRoot");
	pathValue(config.cacheRoot, "cacheRoot");
	normalizeMode(config.mode);
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

function cacheConfig(global: PartialConfig | undefined, project: PartialConfig | undefined): CacheConfig {
	const result = { ...DEFAULT_CONFIG.cache };
	for (const name of Object.keys(result) as Array<keyof CacheConfig>) {
		const globalValue = global?.cache?.[name];
		const projectValue = project?.cache?.[name];
		if (globalValue !== undefined && typeof globalValue !== "boolean") throw new Error(`cache.${name} must be a boolean`);
		if (projectValue !== undefined && typeof projectValue !== "boolean") throw new Error(`cache.${name} must be a boolean`);
		const globallyAllowed = globalValue ?? result[name];
		result[name] = projectValue === undefined ? globallyAllowed : globallyAllowed && projectValue;
	}
	return result;
}

export function mergeConfig(global: PartialConfig | undefined, project: PartialConfig | undefined): SandboxConfig {
	validateConfig(global);
	validateConfig(project);
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
		workspaceRoot: pathValue(global?.workspaceRoot, "workspaceRoot") ?? DEFAULT_CONFIG.workspaceRoot,
		cacheRoot: pathValue(global?.cacheRoot, "cacheRoot") ?? DEFAULT_CONFIG.cacheRoot,
		network: { allow: effectiveAllow },
		environment: { allow: effectiveEnv },
		filesystem: { denyRead },
		cache: cacheConfig(global, project),
	};
}

export async function loadConfig(projectRoot: string, projectTrusted: boolean): Promise<SandboxConfig> {
	const globalConfig = await readConfig(join(getAgentDir(), "sandbox.yaml"));
	const projectConfig = projectTrusted ? await readConfig(join(projectRoot, CONFIG_DIR_NAME, "sandbox.yaml")) : undefined;
	return mergeConfig(globalConfig, projectConfig);
}
