import { realpath } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findGitRoot } from "../sandbox/workspace/manager.ts";
import { DEFAULT_PERMISSION_CONFIG, loadPermissionConfig } from "./config.ts";
import {
	checkReadPath,
	checkWritePath,
	createFilesystemPolicy,
	isLexicallyInsideGuestWorkspace,
	type FilesystemPolicy,
} from "./policy/filesystem.ts";
import { classifyShell } from "./policy/shell.ts";
import { classifyPermissionTool, isReadTool, isWriteTool } from "./policy/tools.ts";
import { getIntegrationState, subscribeIntegrationState } from "./runtime-bridge.ts";
import { effectivePermissionMode, initialPermissionMode, restorePermissionMode } from "./state.ts";
import type { PermissionConfig, PermissionMode, PersistedPermissionState, PolicyDecision } from "./types.ts";

const ENTRY_TYPE = "permission-mode";
const MODE_LABELS: Record<PermissionMode, string> = {
	"read-only": "RO",
	"workspace-write": "WW",
	"full-access": "FULL",
};

function parseMode(value: unknown): PermissionMode | undefined {
	return value === "read-only" || value === "workspace-write" || value === "full-access" ? value : undefined;
}

function pathInput(input: unknown): string {
	if (!input || typeof input !== "object") return ".";
	const value = (input as { path?: unknown }).path;
	return typeof value === "string" && value !== "" ? value : ".";
}

function commandInput(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const value = (input as { command?: unknown }).command;
	return typeof value === "string" ? value : "";
}

function latestPersistedMode(ctx: ExtensionContext): PermissionMode | undefined {
	const entry = ctx.sessionManager
		.getBranch()
		.filter((candidate: { type: string; customType?: string }) => candidate.type === "custom" && candidate.customType === ENTRY_TYPE)
		.pop() as { data?: PersistedPermissionState } | undefined;
	return parseMode(entry?.data?.mode);
}

async function workspaceRoot(cwd: string): Promise<string> {
	try {
		return await findGitRoot(cwd);
	} catch {
		return realpath(cwd);
	}
}

export default function permissionModeExtension(pi: ExtensionAPI): void {
	let baseMode: PermissionMode = "workspace-write";
	let config: PermissionConfig = DEFAULT_PERMISSION_CONFIG;
	let filesystem: FilesystemPolicy | undefined;
	let currentContext: ExtensionContext | undefined;
	let configError: string | undefined;
	const hiddenTools = new Set<string>();

	pi.registerFlag("permission-mode", {
		description: "Permission mode: read-only, workspace-write, or full-access",
		type: "string",
		default: "",
	});

	function effectiveMode(): PermissionMode {
		return effectivePermissionMode(baseMode, getIntegrationState().planMode);
	}

	function updateStatus(ctx: ExtensionContext): void {
		const integration = getIntegrationState();
		const suffix = [integration.planMode ? "PLAN" : undefined, integration.sandbox ? "SBX" : undefined]
			.filter(Boolean)
			.join("·");
		const label = `${MODE_LABELS[effectiveMode()]}${suffix ? `·${suffix}` : ""}`;
		ctx.ui.setStatus("permission-mode", ctx.ui.theme.fg(configError ? "error" : effectiveMode() === "full-access" ? "warning" : "accent", `perm:${label}`));
	}

	function syncActiveTools(): void {
		let active = pi.getActiveTools();
		const enabled = active.filter((name) => classifyPermissionTool(name, config) !== "disabled");
		if (enabled.length !== active.length) {
			pi.setActiveTools(enabled);
			active = enabled;
		}
		if (effectiveMode() === "read-only") {
			const next = active.filter((name) => {
				const capability = classifyPermissionTool(name, config);
				if (capability === "disabled") return false;
				const remove = capability === "workspace-write" || capability === "full";
				if (remove) hiddenTools.add(name);
				return !remove;
			});
			if (next.length !== active.length) pi.setActiveTools(next);
			return;
		}
		if (hiddenTools.size > 0) {
			const registered = new Set(pi.getAllTools().map((tool) => tool.name));
			const restore = [...hiddenTools].filter((name) => registered.has(name) && !config.disabledTools.includes(name));
			pi.setActiveTools([...new Set([...active, ...restore])]);
			hiddenTools.clear();
		}
	}

	function refreshPresentation(): void {
		if (!currentContext) return;
		syncActiveTools();
		updateStatus(currentContext);
	}

	const unsubscribeIntegration = subscribeIntegrationState(refreshPresentation);

	function persistMode(): void {
		pi.appendEntry<PersistedPermissionState>(ENTRY_TYPE, { version: 1, mode: baseMode });
	}

	async function loadState(ctx: ExtensionContext): Promise<void> {
		currentContext = ctx;
		configError = undefined;
		const root = await workspaceRoot(ctx.cwd);
		try {
			config = await loadPermissionConfig(root, ctx.isProjectTrusted());
			filesystem = await createFilesystemPolicy(root, config.readRoots, config.allowSensitivePaths);
			const rawFlag = pi.getFlag("permission-mode");
			const cliMode = rawFlag === "" || rawFlag === undefined ? undefined : parseMode(rawFlag);
			if (rawFlag !== "" && rawFlag !== undefined && !cliMode) {
				throw new Error(`invalid --permission-mode: ${String(rawFlag)}`);
			}
			const persisted = latestPersistedMode(ctx);
			baseMode = initialPermissionMode(cliMode, persisted, config.defaultMode);
		} catch (error) {
			configError = (error as Error).message;
			config = DEFAULT_PERMISSION_CONFIG;
			filesystem = await createFilesystemPolicy(root, [], []);
			baseMode = "read-only";
			if (ctx.hasUI) ctx.ui.notify(`Permission policy failed closed: ${configError}`, "error");
		}
		syncActiveTools();
		updateStatus(ctx);
	}

	async function restoreBranch(ctx: ExtensionContext): Promise<void> {
		currentContext = ctx;
		const persisted = latestPersistedMode(ctx);
		baseMode = restorePermissionMode(persisted, config.defaultMode);
		if (configError) baseMode = "read-only";
		syncActiveTools();
		updateStatus(ctx);
	}

	async function confirmCall(ctx: ExtensionContext, toolName: string, reason: string, detail: string): Promise<boolean> {
		if (!ctx.hasUI) return false;
		return ctx.ui.confirm(
			`Allow ${toolName} once?`,
			`${reason}\n\n${detail}\n\nThis approval is not remembered.`,
		);
	}

	async function fileDecision(toolName: string, input: unknown, mode: PermissionMode): Promise<PolicyDecision> {
		if (!filesystem) return { kind: "deny", reason: "filesystem policy is not initialized" };
		const path = pathInput(input);
		const sandbox = getIntegrationState().sandbox;
		if (isReadTool(toolName)) {
			if (sandbox) return isLexicallyInsideGuestWorkspace(path) ? { kind: "allow" } : { kind: "deny", reason: `guest path escapes /workspace: ${path}` };
			const reason = await checkReadPath(filesystem, path);
			return reason ? { kind: "deny", reason } : { kind: "allow" };
		}
		if (isWriteTool(toolName)) {
			if (mode === "read-only") return { kind: "deny", reason: "write tools are disabled in Read Only" };
			if (sandbox) return isLexicallyInsideGuestWorkspace(path) ? { kind: "allow" } : { kind: "deny", reason: `guest path escapes /workspace: ${path}` };
			const reason = await checkWritePath(filesystem, path);
			return reason ? { kind: "deny", reason } : { kind: "allow" };
		}
		return { kind: "deny", reason: `unsupported file tool: ${toolName}` };
	}

	async function decide(toolName: string, input: unknown): Promise<PolicyDecision> {
		const mode = effectiveMode();
		const capability = classifyPermissionTool(toolName, config);
		if (capability === "disabled") return { kind: "deny", reason: "tool is disabled by trusted project policy" };
		if (mode === "full-access") return { kind: "allow" };
		if (toolName === "bash") return classifyShell(commandInput(input), mode);
		if (isReadTool(toolName) || isWriteTool(toolName)) return fileDecision(toolName, input, mode);
		if (capability === "read" || capability === "network-read") return { kind: "allow" };
		if (capability === "workspace-write") {
			return mode === "read-only" ? { kind: "deny", reason: "tool can write and the effective mode is Read Only" } : { kind: "allow" };
		}
		if (capability === "full") {
			return mode === "read-only"
				? { kind: "deny", reason: "tool requires unrestricted access" }
				: { kind: "confirm", reason: "trusted tool is classified as requiring full access" };
		}
		return mode === "read-only"
			? { kind: "deny", reason: "unclassified tools are blocked in Read Only" }
			: { kind: "confirm", reason: "tool is not classified by global permission policy" };
	}

	pi.on("tool_call", async (event, ctx) => {
		try {
			const decision = await decide(event.toolName, event.input);
			if (decision.kind === "allow") return;
			const detail = event.toolName === "bash" ? commandInput(event.input) : JSON.stringify(event.input);
			if (decision.kind === "confirm" && await confirmCall(ctx, event.toolName, decision.reason, detail)) return;
			const reason = decision.kind === "confirm" && !ctx.hasUI
				? `${decision.reason}; interactive approval is unavailable`
				: decision.reason;
			if (ctx.hasUI) ctx.ui.notify(`Permission denied (${MODE_LABELS[effectiveMode()]}): ${reason}`, "warning");
			return { block: true, reason: `Permission denied in ${effectiveMode()}: ${reason}. Use /permissions to change mode.` };
		} catch (error) {
			const reason = `permission policy error: ${(error as Error).message}`;
			if (ctx.hasUI) ctx.ui.notify(reason, "error");
			return { block: true, reason: `${reason}. The call was blocked fail-closed.` };
		}
	});

	pi.registerCommand("permissions", {
		description: "Show or change the Agent permission mode",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Permissions can only be changed while the Agent is idle", "warning");
				return;
			}
			if (getIntegrationState().planMode) {
				ctx.ui.notify("Plan mode forces Read Only; exit plan mode before changing permissions", "warning");
				return;
			}
			const choice = await ctx.ui.select("Agent permission mode", ["Read Only", "Workspace Write", "Full Access"]);
			const selected: PermissionMode | undefined = choice === "Read Only"
				? "read-only"
				: choice === "Workspace Write"
					? "workspace-write"
					: choice === "Full Access" ? "full-access" : undefined;
			if (!selected || selected === baseMode) return;
			if (selected === "full-access") {
				const confirmed = await ctx.ui.confirm(
					"Enable Full Access?",
					"The permission extension will stop blocking Agent tool calls. Pi and extensions still run with your user privileges.",
				);
				if (!confirmed) return;
			}
			baseMode = selected;
			persistMode();
			syncActiveTools();
			updateStatus(ctx);
			ctx.ui.notify(`Permission mode changed to ${choice}`, selected === "full-access" ? "warning" : "info");
		},
	});

	pi.on("before_agent_start", async (event) => {
		const integration = getIntegrationState();
		const root = integration.sandbox ? "/workspace (Gondolin guest)" : filesystem?.workspace ?? "unavailable";
		const policy = [
			"[AGENT PERMISSION POLICY]",
			`mode=${effectiveMode()}`,
			`workspace=${root}`,
			"Only the user can change the mode with /permissions.",
			"Do not retry denied operations through alternate tools.",
		].join("\n");
		return { systemPrompt: `${event.systemPrompt}\n\n${policy}` };
	});

	pi.on("session_start", async (_event, ctx) => loadState(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreBranch(ctx));
	pi.on("session_shutdown", async () => {
		currentContext?.ui.setStatus("permission-mode", undefined);
		currentContext = undefined;
		unsubscribeIntegration();
	});
}
