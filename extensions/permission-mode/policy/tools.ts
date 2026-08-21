import type { PermissionConfig, ToolCapability } from "../types.ts";

const BUILTIN_CAPABILITIES: Record<string, ToolCapability> = {
	read: "read",
	grep: "read",
	find: "read",
	ls: "read",
	questionnaire: "read",
	write: "workspace-write",
	edit: "workspace-write",
	web_search: "network-read",
	source_check: "network-read",
	fetch_content: "network-read",
	get_search_content: "network-read",
	sandbox_status: "read",
};

export function classifyPermissionTool(name: string, config: PermissionConfig): ToolCapability | "disabled" | "unknown" {
	if (config.disabledTools.includes(name)) return "disabled";
	return config.tools[name] ?? BUILTIN_CAPABILITIES[name] ?? (name === "bash" ? "unknown" : "unknown");
}

export function isReadTool(name: string): boolean {
	return name === "read" || name === "grep" || name === "find" || name === "ls";
}

export function isWriteTool(name: string): boolean {
	return name === "write" || name === "edit";
}
