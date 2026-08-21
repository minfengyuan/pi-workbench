import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";
import type { PermissionConfig, PermissionMode, ToolCapability } from "./types.ts";

interface RawConfig {
	defaultMode?: unknown;
	allowedReadRoots?: unknown;
	readRoots?: unknown;
	allowSensitivePaths?: unknown;
	tools?: unknown;
	disabledTools?: unknown;
}

const GLOBAL_KEYS = new Set(["defaultMode", "allowedReadRoots", "allowSensitivePaths", "tools"]);
const PROJECT_KEYS = new Set(["defaultMode", "readRoots", "disabledTools"]);
const CAPABILITIES = new Set<ToolCapability>(["read", "workspace-write", "network-read", "full"]);

export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
	defaultMode: "workspace-write",
	readRoots: [],
	allowSensitivePaths: [],
	tools: {},
	disabledTools: [],
};

async function readConfig(path: string): Promise<RawConfig | undefined> {
	try {
		const value = parse(await readFile(path, "utf8"));
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("root must be a mapping");
		return value as RawConfig;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Invalid permission config ${path}: ${(error as Error).message}`);
	}
}

function rejectUnknownKeys(config: RawConfig | undefined, allowed: Set<string>, scope: string): void {
	if (!config) return;
	const unknown = Object.keys(config).filter((key) => !allowed.has(key));
	if (unknown.length > 0) throw new Error(`${scope} permission config has unknown fields: ${unknown.join(", ")}`);
}

function mode(value: unknown, field: string): Exclude<PermissionMode, "full-access"> | undefined {
	if (value === undefined) return undefined;
	if (value !== "read-only" && value !== "workspace-write") {
		throw new Error(`${field} must be read-only or workspace-write`);
	}
	return value;
}

function strings(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
		throw new Error(`${field} must be an array of non-empty strings`);
	}
	return [...new Set(value)];
}

function absolutePaths(value: unknown, field: string): string[] | undefined {
	const values = strings(value, field);
	if (!values) return undefined;
	for (const path of values) if (!isAbsolute(path)) throw new Error(`${field} entries must be absolute paths: ${path}`);
	return values.map(normalize);
}

function tools(value: unknown): Record<string, ToolCapability> {
	if (value === undefined) return {};
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("tools must be a mapping");
	const result: Record<string, ToolCapability> = {};
	for (const [name, capability] of Object.entries(value)) {
		if (name.trim() === "" || !CAPABILITIES.has(capability as ToolCapability)) {
			throw new Error(`tools.${name || "<empty>"} must be read, workspace-write, network-read, or full`);
		}
		result[name] = capability as ToolCapability;
	}
	return result;
}

export function mergePermissionConfig(global: RawConfig | undefined, project: RawConfig | undefined): PermissionConfig {
	rejectUnknownKeys(global, GLOBAL_KEYS, "global");
	rejectUnknownKeys(project, PROJECT_KEYS, "project");
	const allowedReadRoots = absolutePaths(global?.allowedReadRoots, "allowedReadRoots") ?? [];
	const selectedReadRoots = absolutePaths(project?.readRoots, "readRoots");
	if (selectedReadRoots) {
		const outside = selectedReadRoots.filter((path) => !allowedReadRoots.includes(path));
		if (outside.length > 0) throw new Error(`project readRoots exceed the global allowlist: ${outside.join(", ")}`);
	}
	return {
		defaultMode: mode(project?.defaultMode, "project defaultMode") ?? mode(global?.defaultMode, "global defaultMode") ?? DEFAULT_PERMISSION_CONFIG.defaultMode,
		readRoots: selectedReadRoots ?? allowedReadRoots,
		allowSensitivePaths: absolutePaths(global?.allowSensitivePaths, "allowSensitivePaths") ?? [],
		tools: tools(global?.tools),
		disabledTools: strings(project?.disabledTools, "disabledTools") ?? [],
	};
}

export async function loadPermissionConfig(projectRoot: string, projectTrusted: boolean): Promise<PermissionConfig> {
	const global = await readConfig(join(getAgentDir(), "permissions.yaml"));
	const project = projectTrusted ? await readConfig(join(projectRoot, CONFIG_DIR_NAME, "permissions.yaml")) : undefined;
	return mergePermissionConfig(global, project);
}
