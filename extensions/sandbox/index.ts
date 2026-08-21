import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { gcSessions } from "@earendil-works/gondolin";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AuditLogger } from "./audit/logger.ts";
import { GondolinBackend } from "./backend/gondolin.ts";
import { buildCacheEnv } from "./cache/manager.ts";
import { loadConfig } from "./config/loader.ts";
import { setSandboxActive } from "../permission-mode/runtime-bridge.ts";
import { buildGuestEnv } from "./policy/environment.ts";
import { classifyTool } from "./policy/tools.ts";
import {
	createGondolinBashOps,
	createGondolinEditOps,
	createGondolinFindOps,
	createGondolinLsOps,
	createGondolinReadOps,
	createGondolinWriteOps,
	executeGondolinGrep,
	GUEST_WORKSPACE,
} from "./tools/gondolin-operations.ts";
import type { SandboxConfig, SandboxState, WorkspaceSnapshot } from "./types.ts";
import { applyPatch, exportPatch, verifyApply } from "./workspace/export.ts";
import { createWorkspace, destroyWorkspace, findGitRoot } from "./workspace/manager.ts";

interface Runtime {
	config: SandboxConfig;
	snapshot: WorkspaceSnapshot;
	backend: GondolinBackend;
	sessionId: string;
}

const SANDBOX_TOOL_NAMES = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "sandbox_status"]);
const EXTENSION_PATH = resolve(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = dirname(EXTENSION_PATH);
const FORBIDDEN_REMOTE_MUTATION = /(?:^|[;&|]\s*)git(?:\s+-\S+)*\s+push(?:\s|$)|\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+publish\b/i;

export default function sandboxExtension(pi: ExtensionAPI): void {
	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd, { exposeSessionEnvironment: false });
	const localGrep = createGrepTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localLs = createLsTool(localCwd);
	const audit = new AuditLogger();
	let runtime: Runtime | undefined;
	let state: SandboxState = { status: "off", blockedTools: [] };
	let devMode = false;

	pi.registerFlag("sandbox", {
		description: "Sandbox mode: dev or off",
		type: "string",
		default: "off",
	});

	function statusLine(ctx: ExtensionContext): void {
		if (!devMode) {
			ctx.ui.setStatus("sandbox", undefined);
			return;
		}
		const web = state.webUrl ? ` | web:${state.webUrl}` : "";
		const lifecycle = state.status === "ready" ? `clone | net:restricted | host-write:off${web}` : `${state.status} | host-write:off`;
		ctx.ui.setStatus("sandbox", ctx.ui.theme.fg(state.status === "error" ? "error" : "accent", `🔒 dev | ${lifecycle}`));
	}

	function requireRuntime(): Runtime {
		if (!devMode || !runtime || state.status !== "ready") throw new Error("Sandbox is not ready; host fallback is disabled");
		return runtime;
	}

	function isOwnedSandboxTool(name: string): boolean {
		if (!SANDBOX_TOOL_NAMES.has(name)) return false;
		const tool = pi.getAllTools().find((candidate) => candidate.name === name);
		if (!tool || tool.sourceInfo.path.startsWith("<")) return false;
		const sourcePath = resolve(tool.sourceInfo.path);
		return sourcePath === EXTENSION_PATH || sourcePath === EXTENSION_ROOT;
	}

	function classifyRuntimeTools(): { active: string[]; blocked: string[] } {
		const active: string[] = [];
		const blocked: string[] = [];
		for (const tool of pi.getAllTools()) (isOwnedSandboxTool(tool.name) ? active : blocked).push(tool.name);
		return { active: [...new Set(active)], blocked: [...new Set(blocked)] };
	}

	async function destroy(ctx?: ExtensionContext): Promise<void> {
		const active = runtime;
		runtime = undefined;
		if (active) {
			try { await active.backend.destroy(); }
			finally { await destroyWorkspace(active.snapshot); }
		}
		if (devMode) {
			state = { ...state, status: "destroyed", instanceId: undefined, workspace: undefined, webUrl: undefined };
			setSandboxActive(false);
			pi.setActiveTools(["sandbox_status"]);
			if (ctx) statusLine(ctx);
		}
	}

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate) {
			if (!devMode) return localRead.execute(id, params, signal, onUpdate);
			const active = requireRuntime();
			const vm = await active.backend.start();
			return createReadTool(GUEST_WORKSPACE, { operations: createGondolinReadOps(vm, active.snapshot.hostSource) })
				.execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate) {
			if (!devMode) return localWrite.execute(id, params, signal, onUpdate);
			const active = requireRuntime();
			const vm = await active.backend.start();
			return createWriteTool(GUEST_WORKSPACE, { operations: createGondolinWriteOps(vm, active.snapshot.hostSource) })
				.execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate) {
			if (!devMode) return localEdit.execute(id, params, signal, onUpdate);
			const active = requireRuntime();
			const vm = await active.backend.start();
			return createEditTool(GUEST_WORKSPACE, { operations: createGondolinEditOps(vm, active.snapshot.hostSource) })
				.execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate) {
			if (!devMode) return localBash.execute(id, params, signal, onUpdate);
			const active = requireRuntime();
			if (FORBIDDEN_REMOTE_MUTATION.test(params.command)) throw new Error("Sandbox policy denies remote mutation");
			const vm = await active.backend.start();
			const env = { ...buildGuestEnv(process.env, active.config.environment.allow), ...buildCacheEnv(active.config.cache) };
			return createBashTool(GUEST_WORKSPACE, {
				exposeSessionEnvironment: false,
				operations: createGondolinBashOps(vm, active.snapshot.hostSource, active.backend.shellPath, env),
			}).execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localLs,
		async execute(id, params, signal, onUpdate) {
			if (!devMode) return localLs.execute(id, params, signal, onUpdate);
			const active = requireRuntime(); const vm = await active.backend.start();
			return createLsTool(GUEST_WORKSPACE, { operations: createGondolinLsOps(vm, active.snapshot.hostSource) }).execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localFind,
		async execute(id, params, signal, onUpdate) {
			if (!devMode) return localFind.execute(id, params, signal, onUpdate);
			const active = requireRuntime(); const vm = await active.backend.start();
			return createFindTool(GUEST_WORKSPACE, { operations: createGondolinFindOps(vm, active.snapshot.hostSource) }).execute(id, params, signal, onUpdate);
		},
	});
	pi.registerTool({
		...localGrep,
		async execute(id, params, signal, onUpdate) {
			if (!devMode) return localGrep.execute(id, params, signal, onUpdate);
			const active = requireRuntime(); const vm = await active.backend.start();
			return executeGondolinGrep(vm, active.snapshot.hostSource, params, signal);
		},
	});
	pi.registerTool({
		name: "sandbox_status",
		label: "Sandbox Status",
		description: "Show the active sandbox isolation status",
		parameters: Type.Object({}),
		async execute() {
			const publicState = {
				status: state.status,
				instanceId: state.instanceId,
				blockedTools: state.blockedTools,
				workspace: state.workspace && {
					guestPath: GUEST_WORKSPACE,
					baseCommit: state.workspace.baseCommit,
					dirty: state.workspace.dirty,
					files: state.workspace.files,
				},
				webUrl: state.webUrl,
				error: state.error,
			};
			return { content: [{ type: "text", text: JSON.stringify(publicState, null, 2) }], details: publicState };
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const requested = pi.getFlag("sandbox");
		if (requested !== "dev" && requested !== "off") {
			pi.setActiveTools([]);
			throw new Error(`Invalid --sandbox mode: ${String(requested)} (expected dev or off)`);
		}
		devMode = requested === "dev";
		setSandboxActive(devMode);
		if (!devMode) { state = { status: "off", blockedTools: [] }; statusLine(ctx); return; }

		pi.setActiveTools([]);
		state = { status: "starting", blockedTools: [] };
		statusLine(ctx);
		try {
			const staleSessions = await gcSessions();
			if (staleSessions > 0) await audit.write({ session: "startup", event: "runtime.gc", details: { removed: staleSessions } });
			const projectRoot = await findGitRoot(ctx.cwd);
			const config = await loadConfig(projectRoot, ctx.isProjectTrusted());
			const snapshot = await createWorkspace(projectRoot, config.workspaceRoot, config.filesystem.denyRead);
			const sessionId = ctx.sessionManager.getSessionId();
			const backend = new GondolinBackend(config, snapshot, audit, sessionId);
			runtime = { config, snapshot, backend, sessionId };
			const vm = await backend.start(ctx);
			const classified = classifyRuntimeTools();
			state = { status: "ready", instanceId: vm.id, workspace: snapshot, blockedTools: classified.blocked };
			pi.setActiveTools(classified.active);
			setSandboxActive(true);
			await audit.write({ session: sessionId, event: "workspace.snapshot", details: { baseCommit: snapshot.baseCommit, dirty: snapshot.dirty, files: snapshot.files } });
			for (const name of classified.blocked) await audit.write({ session: sessionId, event: "tool.classified", decision: "deny", resource: name });
			statusLine(ctx);
		} catch (error) {
			const failedRuntime = runtime;
			runtime = undefined;
			if (failedRuntime) {
				try { await failedRuntime.backend.destroy(); } catch { /* preserve startup failure */ }
				try { await destroyWorkspace(failedRuntime.snapshot); } catch { /* preserve startup failure */ }
			}
			state = { ...state, status: "error", error: (error as Error).message, workspace: undefined, instanceId: undefined };
			pi.setActiveTools([]);
			statusLine(ctx);
			throw error;
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await destroy(ctx);
		setSandboxActive(false);
	});

	pi.on("tool_call", async (event) => {
		if (!devMode) return;
		if (classifyTool(event.toolName) === "unknown" || !isOwnedSandboxTool(event.toolName)) {
			await audit.write({ session: runtime?.sessionId ?? "unknown", event: "tool.call", decision: "deny", resource: event.toolName });
			return { block: true, reason: `Sandbox blocked unclassified tool: ${event.toolName}`, terminate: true };
		}
		if (event.toolName === "bash" && FORBIDDEN_REMOTE_MUTATION.test(String((event.input as { command?: unknown }).command ?? ""))) {
			await audit.write({ session: runtime?.sessionId ?? "unknown", event: "tool.call", decision: "deny", resource: event.toolName });
			return { block: true, reason: "Sandbox policy denies remote mutation", terminate: true };
		}
		await audit.write({ session: runtime?.sessionId ?? "unknown", event: "tool.call", decision: "allow", resource: event.toolName });
	});

	pi.on("user_bash", async (event) => {
		if (!devMode) return;
		try {
			const active = requireRuntime();
			if (FORBIDDEN_REMOTE_MUTATION.test(event.command)) {
				await audit.write({ session: active.sessionId, event: "tool.call", decision: "deny", resource: "user_bash" });
				return { result: { output: "Sandbox policy denies remote mutation", exitCode: 126, cancelled: false, truncated: false } };
			}
			await audit.write({ session: active.sessionId, event: "tool.call", decision: "allow", resource: "user_bash" });
			const vm = await active.backend.start();
			return {
				operations: createGondolinBashOps(vm, active.snapshot.hostSource, active.backend.shellPath, {
					...buildGuestEnv(process.env, active.config.environment.allow),
					...buildCacheEnv(active.config.cache),
				}),
			};
		} catch (error) {
			return {
				result: {
					output: `Sandbox unavailable; Host fallback denied: ${(error as Error).message}`,
					exitCode: 126,
					cancelled: false,
					truncated: false,
				},
			};
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!devMode) return;
		requireRuntime();
		const guestLine = `Current working directory: ${GUEST_WORKSPACE} (isolated disposable clone; host-write disabled)`;
		const hostLines = new Set([
			`Current working directory: ${ctx.cwd}`,
			`Current working directory: ${localCwd}`,
		]);
		let systemPrompt = event.systemPrompt;
		for (const hostLine of hostLines) systemPrompt = systemPrompt.replaceAll(hostLine, guestLine);
		if (!systemPrompt.includes(guestLine)) systemPrompt += `\n\n${guestLine}`;
		return { systemPrompt };
	});

	pi.registerCommand("sandbox", {
		description: "Sandbox status, tools, files, network, processes, serve, reset, diff, apply, or destroy",
		getArgumentCompletions: (prefix) => ["status", "tools", "files", "network", "processes", "serve", "reset", "diff", "apply", "destroy"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const [action = "status", ...actionArgs] = args.trim().split(/\s+/).filter(Boolean);
			if (action === "status") { ctx.ui.notify(JSON.stringify(state, null, 2), "info"); return; }
			if (action === "tools") {
				ctx.ui.notify(`Active: ${pi.getActiveTools().join(", ") || "none"}\nBlocked: ${state.blockedTools.join(", ") || "none"}`, "info"); return;
			}
			if (action === "destroy") { await destroy(ctx); ctx.ui.notify("Sandbox destroyed", "info"); return; }
			const active = requireRuntime();
			if (action === "files") {
				ctx.ui.notify((await active.backend.listFiles()) || "No sandbox changes", "info"); return;
			}
			if (action === "network") {
				ctx.ui.notify(`Default: deny\nAllowed HTTPS hosts:\n${active.config.network.allow.map((host) => `- ${host}`).join("\n") || "(none)"}`, "info"); return;
			}
			if (action === "processes") {
				ctx.ui.notify((await active.backend.listProcesses()) || "No sandbox processes", "info"); return;
			}
			if (action === "serve") {
				const port = Number(actionArgs[0]);
				const webUrl = await active.backend.serve(port);
				state = { ...state, webUrl };
				statusLine(ctx);
				ctx.ui.notify(`Sandbox web server: ${webUrl}`, "info"); return;
			}
			if (action === "reset") {
				if (!ctx.hasUI || !(await ctx.ui.confirm("Reset sandbox?", "Discard every change in the disposable workspace?"))) {
					ctx.ui.notify("Sandbox reset cancelled", "info"); return;
				}
				await active.backend.resetWorkspace(active.snapshot.snapshotCommit);
				await audit.write({ session: active.sessionId, event: "workspace.reset", decision: "allow" });
				ctx.ui.notify("Sandbox reset to launch snapshot", "info"); return;
			}
			const patch = await exportPatch(active.snapshot);
			if (action === "diff") {
				const text = patch.length === 0 ? "No sandbox changes" : truncateHead(patch.toString("utf8")).content;
				ctx.ui.notify(text, "info"); return;
			}
			if (action === "apply") {
				if (patch.length === 0) { ctx.ui.notify("No sandbox changes", "info"); return; }
				await verifyApply(active.snapshot, patch);
				if (!ctx.hasUI || !(await ctx.ui.confirm("Apply sandbox changes?", `Apply ${patch.length} bytes to ${active.snapshot.hostSource}?`))) {
					ctx.ui.notify("Sandbox apply cancelled", "info"); return;
				}
				await applyPatch(active.snapshot, patch);
				await audit.write({ session: active.sessionId, event: "workspace.applied", decision: "allow", details: { bytes: patch.length } });
				ctx.ui.notify("Sandbox changes applied", "info"); return;
			}
			ctx.ui.notify(`Unknown sandbox action: ${action}`, "error");
		},
	});
}
