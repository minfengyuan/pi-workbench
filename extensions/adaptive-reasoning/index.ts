import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AdaptiveController } from "./controller.ts";
import { DEFAULT_CONFIG, loadConfig, type AdaptiveConfig } from "./config.ts";
import { buildEvaluatorState } from "./context.ts";
import { JevClient } from "./jev.ts";

const ENTRY_TYPE = "adaptive-reasoning";
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

async function resolveCredential(promise: Promise<string | undefined>, signal: AbortSignal): Promise<string | undefined> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
		signal.addEventListener("abort", abort, { once: true });
		promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
	});
}

export default function adaptiveReasoningExtension(pi: ExtensionAPI): void {
	const controller = new AdaptiveController("medium");
	const client = new JevClient();
	let config: AdaptiveConfig = { ...DEFAULT_CONFIG };
	let configError = false;
	let request: AbortController | undefined;
	let inputPending = false;
	let initialUserPending = false;
	let currentModel: ExtensionContext["model"];
	let observedLevel: ThinkingLevel = "medium";
	const modelTransitions: { from: ThinkingLevel; to: ThinkingLevel }[] = [];
	let modelThinkingObserved = false;

	pi.registerFlag("adaptive-reasoning", { description: "Adaptive reasoning: on or off (session only)", type: "string", default: "" });
	function cancel(): void { request?.abort(); request = undefined; controller.invalidate(); }
	function notify(ctx: ExtensionContext, content: string, type: "info" | "warning" = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(content, type);
		else pi.sendMessage({ customType: "adaptive-reasoning-status", content, display: true }, { triggerTurn: false });
	}
	function persist(): void { pi.appendEntry(ENTRY_TYPE, { version: 1, enabled: controller.enabled, baseline: controller.baseline }); }
	function status(ctx: ExtensionContext): void {
		const label = configError ? "CONFIG!" : !controller.enabled ? "OFF" : controller.paused ? (controller.paused === "manual override" ? "MANUAL" : "JEV!") : controller.decision ? `AUTO·${({ off: "O", minimal: "MIN", low: "L", medium: "M", high: "H", xhigh: "XH", max: "MAX" }[controller.decision.level])}·${controller.decision.remaining}` : "AUTO";
		ctx.ui.setStatus(ENTRY_TYPE, `reason:${label}`);
	}
	function apply(level: ThinkingLevel): void {
		const from = pi.getThinkingLevel();
		observedLevel = from;
		if (from === level) return;
		const transition = { from, to: level }; controller.expectedTransitions.push(transition);
		try { pi.setThinkingLevel(level); }
		catch (error) { const index = controller.expectedTransitions.indexOf(transition); if (index !== -1) controller.expectedTransitions.splice(index, 1); throw error; }
		observedLevel = pi.getThinkingLevel();
		if (observedLevel !== level) throw new Error("Pi did not apply requested thinking level");
	}
	function observeManualSelection(): void {
		const level = pi.getThinkingLevel();
		if (level === observedLevel) return;
		// setThinkingLevel changes state synchronously, but its event can be delayed
		// by another extension. Never restore/evaluate over that newer user choice.
		// Its eventual notification has already been accounted for, even if a new
		// task starts before another extension releases that notification.
		controller.expectedTransitions.push({ from: observedLevel, to: level });
		observedLevel = level; cancel(); controller.baseline = level;
		controller.paused = "manual override"; persist();
	}
	function restore(): void {
		observeManualSelection();
		// A model change may clamp the baseline to the new model's capabilities.
		apply(currentModel ? clampThinkingLevel(currentModel, controller.baseline) : controller.baseline);
	}
	function messages(ctx: ExtensionContext): unknown[] {
		return ctx.sessionManager.getBranch().filter((e) => e.type === "message").map((e) => e.message);
	}
	function lastUser(ctx: ExtensionContext): unknown { return messages(ctx).filter((m: any) => m.role === "user").pop(); }
	async function evaluate(ctx: ExtensionContext, incomingMessage?: unknown): Promise<void> {
		observeManualSelection();
		if (!controller.enabled || controller.paused || !ctx.model?.reasoning || configError) { status(ctx); return; }
		cancel();
		const revision = controller.revision;
		const model = ctx.model;
		const initialLevel = pi.getThinkingLevel();
		const isCurrent = () => revision === controller.revision && initialLevel === pi.getThinkingLevel() && model.id === ctx.model?.id && model.provider === ctx.model?.provider;
		const active = new AbortController(); request = active;
		const deadline = AbortSignal.timeout(30_000);
		const signal = AbortSignal.any([active.signal, deadline, ...(ctx.signal ? [ctx.signal] : [])]);
		try {
			const apiKey = await resolveCredential(ctx.modelRegistry.getApiKeyForProvider("openrouter"), signal);
			signal.throwIfAborted();
			if (!isCurrent()) { cancel(); return; }
			if (!apiKey) { controller.fail("no OpenRouter credentials"); controller.enabled = false; restore(); persist(); notify(ctx, "Adaptive reasoning disabled: no OpenRouter credentials", "warning"); status(ctx); return; }
			// message_end is awaited before Pi persists the incoming user message.
			const history = messages(ctx);
			if (incomingMessage) history.push(incomingMessage);
			const state = buildEvaluatorState(history, {
				model: `${model.provider}/${model.id}`, supportedEfforts: getSupportedThinkingLevels(model).map((l) => l === "off" ? "none" : l),
				latestUserPrompt: controller.latestUserPrompt, step: controller.step, previousEffort: pi.getThinkingLevel() === "off" ? "none" : pi.getThinkingLevel(), newToolFailures: controller.toolFailures,
			});
			const decision = await client.decide(state, apiKey, config.maxLeaseSteps, signal);
			signal.throwIfAborted();
			if (!isCurrent()) { cancel(); return; }
			if (controller.accept(decision, revision)) {
				const previous = pi.getThinkingLevel(); apply(decision.level);
				if (previous !== decision.level && ctx.hasUI) ctx.ui.notify(`reason: ${previous} → ${decision.level} · lease ${decision.leaseSteps}`, "info");
			}
		} catch {
			if (isCurrent()) { if (signal.aborted && !deadline.aborted) controller.invalidate(); else controller.fail(); restore(); }
		} finally { if (request === active) request = undefined; status(ctx); }
	}
	async function initialize(ctx: ExtensionContext): Promise<void> {
		cancel(); inputPending = false; initialUserPending = false; controller.paused = undefined;
		currentModel = ctx.model; modelTransitions.length = 0; modelThinkingObserved = false;
		controller.baseline = pi.getThinkingLevel(); observedLevel = controller.baseline;
		try { config = await loadConfig(); configError = false; }
		catch { config = { ...DEFAULT_CONFIG }; configError = true; notify(ctx, "Invalid adaptive reasoning config; disabled", "warning"); }
		controller.enabled = config.enabled;
		const entry = ctx.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === ENTRY_TYPE).pop();
		if (entry?.type === "custom") {
			const data = entry.data as { version?: unknown; enabled?: unknown; baseline?: unknown };
			if (data?.version === 1 && typeof data.enabled === "boolean" && typeof data.baseline === "string" && LEVELS.includes(data.baseline)) { controller.enabled = data.enabled; controller.baseline = data.baseline as ThinkingLevel; }
		}
		const flag = pi.getFlag("adaptive-reasoning");
		if (flag === "on" || flag === "off") controller.enabled = flag === "on";
		else if (flag) { configError = true; notify(ctx, "--adaptive-reasoning requires on or off; disabled", "warning"); }
		if (configError) controller.enabled = false;
		const user = lastUser(ctx) as { content?: unknown };
		if (typeof user?.content === "string") controller.latestUserPrompt = user.content;
		else if (Array.isArray(user?.content)) controller.latestUserPrompt = user.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
		else controller.latestUserPrompt = "";
		restore(); status(ctx);
	}
	pi.on("session_start", async (_event, ctx) => { await initialize(ctx); });
	pi.on("before_agent_start", async (event, ctx) => {
		cancel(); if (controller.enabled) restore(); controller.newTask(event.prompt); inputPending = false; initialUserPending = true;
		if (controller.enabled) { persist(); await evaluate(ctx); }
	});
	pi.on("input", (_event, ctx) => {
		cancel(); inputPending = !ctx.isIdle();
		if (controller.enabled) restore(); status(ctx);
		return { action: "continue" };
	});
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "user") return;
		// The ordinary prompt was already evaluated by before_agent_start.
		if (initialUserPending) { initialUserPending = false; return; }
		cancel(); if (controller.enabled) restore();
		const content = event.message.content;
		const prompt = typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		controller.newTask(prompt); inputPending = ctx.hasPendingMessages();
		if (controller.enabled) { persist(); await evaluate(ctx, event.message); }
	});
	pi.on("turn_end", async (event, ctx) => {
		observeManualSelection();
		controller.finishGeneration(event.toolResults.filter((r) => r.isError).length);
		if (!controller.enabled || controller.paused || !ctx.model?.reasoning) { status(ctx); return; }
		const message = event.message as { stopReason?: string };
		if (message.stopReason === "error" || message.stopReason === "aborted") return;
		// Queued input enters the agent after turn_end. Evaluate it at message_end,
		// before prepareRequest snapshots the next generation's thinking level.
		if (inputPending) { restore(); status(ctx); return; }
		if (!event.toolResults.length && !ctx.hasPendingMessages()) return;
		if (!controller.canReuse()) await evaluate(ctx); else status(ctx);
	});
	pi.on("thinking_level_select", (event, ctx) => {
		const expected = controller.expectedTransitions.findIndex((t) => t.from === event.previousLevel && t.to === event.level);
		if (expected !== -1) { controller.expectedTransitions.splice(expected, 1); return; }
		const modelExpected = modelTransitions.findIndex((t) => t.from === event.previousLevel && t.to === event.level);
		if (modelExpected !== -1) { modelTransitions.splice(modelExpected, 1); return; }
		if ((ctx.model?.id !== currentModel?.id || ctx.model?.provider !== currentModel?.provider) && !modelThinkingObserved) {
			// Pi changes the model before emitting its automatic thinking change.
			modelThinkingObserved = true; observedLevel = event.level; cancel(); status(ctx); return;
		}
		if (pi.getThinkingLevel() !== event.level) return;
		observedLevel = event.level;
		if (controller.select(event.level, event.previousLevel)) { request?.abort(); request = undefined; persist(); }
		status(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		const selectedLevel = pi.getThinkingLevel();
		if (!modelThinkingObserved && (currentModel?.id !== ctx.model?.id || currentModel?.provider !== ctx.model?.provider) && observedLevel !== selectedLevel) {
			modelTransitions.push({ from: observedLevel, to: selectedLevel });
		}
		modelThinkingObserved = false;
		observedLevel = selectedLevel;
		currentModel = ctx.model; cancel();
		// Pi has already applied scoped/per-model/default thinking for the new model.
		controller.baseline = selectedLevel; persist(); status(ctx);
	});
	pi.on("session_compact", (_event, ctx) => { cancel(); inputPending = false; initialUserPending = false; if (controller.enabled) restore(); status(ctx); });
	pi.on("session_tree", async (_event, ctx) => { await initialize(ctx); });
	pi.on("agent_settled", (_event, ctx) => { cancel(); inputPending = false; initialUserPending = false; if (controller.enabled) restore(); status(ctx); });
	pi.on("session_shutdown", () => { cancel(); if (controller.enabled) restore(); });
	pi.registerCommand("adaptive-reasoning", {
		description: "Enable, disable or inspect adaptive reasoning",
		handler: async (args, ctx) => {
			let action = args.trim();
			if (!action && ctx.hasUI) action = (await ctx.ui.select("Adaptive reasoning", ["on", "off", "status"])) ?? "status";
			if (!action || action === "status") {
				notify(ctx, `Adaptive reasoning: ${controller.enabled ? "enabled" : "disabled"}\nEvaluator: OpenRouter / typesafe/jev-1.13\nModel: ${ctx.model?.id ?? "none"}\nCurrent: ${pi.getThinkingLevel()}\nBaseline: ${controller.baseline}\nLease: ${controller.decision?.remaining ?? 0}\nPaused: ${controller.paused ?? "no"}`, "info"); return;
			}
			if (action !== "on" && action !== "off") { notify(ctx, "Usage: /adaptive-reasoning on|off|status", "warning"); return; }
			if (action === "on" && configError) { notify(ctx, "Fix invalid global config before enabling adaptive reasoning", "warning"); return; }
			cancel(); controller.enabled = action === "on"; controller.paused = undefined;
			restore(); persist(); status(ctx);
		},
	});
}
