import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/adaptive-reasoning/index.ts";

test("real AgentSession applies first and subsequent generation decisions without changing global defaults", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-adaptive-session-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		if (calls === 3) return new Response("", { status: 401 });
		return Response.json({ model: "typesafe/jev-1.13", provider: "TypeSafe", answers: { effort: { type: "choice", choice: calls === 1 ? "high" : "low" }, lease: { type: "choice", choice: "1" } } });
	});
	try {
		await writeFile(join(dir, "adaptive-reasoning.yaml"), "enabled: true\n");
		const settingsText = JSON.stringify({ defaultThinkingLevel: "medium", compaction: { enabled: false }, retry: { enabled: false } });
		await writeFile(join(dir, "settings.json"), settingsText);
		const settings = SettingsManager.create(dir, dir);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai", async () => ({ type: "api_key", key: "fake" }));
		await credentials.modify("openrouter", async () => ({ type: "api_key", key: "fake" }));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [extension] });
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const model = getModel("openai", "gpt-5.4");
		const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, thinkingLevel: "medium", settingsManager: settings, sessionManager: SessionManager.inMemory(dir), resourceLoader: loader, tools: ["probe"], customTools: [{ name: "probe", label: "probe", description: "test", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "verified" }], details: {} }) }] });
		const reasoning: unknown[] = [];
		session.agent.streamFunction = (_model, _context, options) => {
			reasoning.push(options?.reasoning);
			const n = reasoning.length;
			const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: n < 3 ? [{ type: "toolCall", id: `call-${n}`, name: "probe", arguments: {} }] : [{ type: "text", text: "done" }], stopReason: n < 3 ? "toolUse" : "stop", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message }); return stream;
		};
		await session.bindExtensions({});
		const extensionErrors: string[] = []; session.extensionRunner.onError((error) => extensionErrors.push(error.error));
		await session.prompt("Solve the test task");
		assert.deepEqual(extensionErrors, []);
		assert.deepEqual(reasoning, ["high", "low", "medium"]);
		assert.equal(calls, 3); assert.equal(session.thinkingLevel, "medium");
		assert.equal(settings.getDefaultThinkingLevel(), "medium"); assert.equal(settings.getGlobalSettings().defaultThinkingLevel, "medium");
		await settings.flush();
		assert.equal(await readFile(join(dir, "settings.json"), "utf8"), settingsText);
		session.dispose();
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
		await rm(dir, { recursive: true, force: true });
	}
});

async function sessionHarness(t: test.TestContext, options: {
	lease?: number;
	beforeExtension?: (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => void;
} = {}) {
	const dir = await mkdtemp(join(tmpdir(), "pi-adaptive-regression-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const states: Array<import("../extensions/adaptive-reasoning/context.ts").EvaluatorState> = [];
	const order: string[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
		const state = JSON.parse(String(init?.body)).state;
		states.push(state); order.push(`evaluate:${state.latestUserPrompt}`);
		return Response.json({ model: "typesafe/jev-1.13", provider: "TypeSafe", answers: {
			effort: { type: "choice", choice: states.length === 1 ? "high" : "low" },
			lease: { type: "choice", choice: String(options.lease ?? 2) },
		} });
	});
	await writeFile(join(dir, "adaptive-reasoning.yaml"), "enabled: true\n");
	await writeFile(join(dir, "settings.json"), JSON.stringify({ defaultThinkingLevel: "medium", modelThinkingLevels: { "openai/gpt-5-mini": "low" }, compaction: { enabled: false }, retry: { enabled: false } }));
	const settings = SettingsManager.create(dir, dir);
	const credentials = new InMemoryCredentialStore();
	for (const provider of ["openai", "openrouter"]) await credentials.modify(provider, async () => ({ type: "api_key", key: "fake" }));
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
		extensionFactories: [...(options.beforeExtension ? [options.beforeExtension] : []), extension] });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const model = getModel("openai", "gpt-5.4");
	let execute = async () => {};
	const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model, thinkingLevel: "medium", settingsManager: settings, sessionManager: SessionManager.inMemory(dir), resourceLoader: loader, tools: ["probe"], customTools: [{ name: "probe", label: "probe", description: "test", parameters: Type.Object({}), execute: async () => {
		await execute(); return { content: [{ type: "text", text: "verified" }], details: {} };
	} }] });
	t.after(async () => {
		session.dispose();
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
		await rm(dir, { recursive: true, force: true });
	});
	let toolGenerations = 0;
	const reasoning: unknown[] = [];
	const prepared: unknown[] = [];
	const originalPrepare = session.agent.prepareRequest!;
	session.agent.prepareRequest = async (...args) => {
		prepared.push(session.thinkingLevel); order.push(`prepare:${session.thinkingLevel}`);
		return (await originalPrepare(...args)) ?? undefined;
	};
	session.agent.streamFunction = (selectedModel, _context, streamOptions) => {
		reasoning.push(streamOptions?.reasoning);
		const toolUse = reasoning.length <= toolGenerations;
		const message: AssistantMessage = { role: "assistant", api: selectedModel.api, provider: selectedModel.provider, model: selectedModel.id,
			content: toolUse ? [{ type: "toolCall", id: `call-${reasoning.length}`, name: "probe", arguments: {} }] : [{ type: "text", text: "done" }], stopReason: toolUse ? "toolUse" : "stop", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: toolUse ? "toolUse" : "stop", message }); return stream;
	};
	await session.bindExtensions({});
	const errors: string[] = [];
	session.extensionRunner.onError((error) => errors.push(error.error));
	t.after(() => assert.deepEqual(errors, []));
	return { session, settings, states, reasoning, prepared, order, tools: (count: number, callback = async () => {}) => { toolGenerations = count; execute = callback; } };
}

test("real AgentSession evaluates an ordinary initial user exactly once and spends leases per generation", async (t) => {
	const h = await sessionHarness(t, { lease: 2 });
	h.tools(3);
	await h.session.prompt("Initial task");
	assert.deepEqual(h.reasoning, ["high", "high", "low", "low"]);
	assert.deepEqual(h.prepared, h.reasoning);
	assert.deepEqual(h.states.map((state) => [state.latestUserPrompt, state.step]), [["Initial task", 0], ["Initial task", 2]]);
	assert.equal(h.session.thinkingLevel, "medium");
});

test("real AgentSession evaluates steering delivered during a tool before the next prepareRequest", async (t) => {
	const h = await sessionHarness(t, { lease: 5 });
	h.tools(1, async () => { await h.session.prompt("Changed task", { streamingBehavior: "steer" }); });
	h.session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "user") h.order.push("user:end");
	});
	await h.session.prompt("Initial task");
	assert.deepEqual(h.reasoning, ["high", "low"]);
	assert.deepEqual(h.prepared, h.reasoning);
	assert.deepEqual(h.states.map((state) => [state.latestUserPrompt, state.step]), [["Initial task", 0], ["Changed task", 0]]);
	assert.deepEqual(h.states[1].priorUserPrompts, ["Initial task"]);
	assert.equal(h.states[1].recentToolCalls[0]?.result, "verified");
	assert.deepEqual(h.order, ["evaluate:Initial task", "user:end", "prepare:high", "evaluate:Changed task", "user:end", "prepare:low"]);
});

test("real AgentSession captures each Pi model baseline across reasoning and non-reasoning round trips", async (t) => {
	const h = await sessionHarness(t);
	await h.session.setModel(getModel("openai", "gpt-5-mini"));
	assert.equal(h.session.thinkingLevel, "low");
	await h.session.prompt("Use the smaller model");
	assert.deepEqual(h.reasoning, ["high"]);
	assert.equal(h.session.thinkingLevel, "low");
	await h.session.setModel(getModel("openai", "gpt-4o"));
	assert.equal(h.session.thinkingLevel, "off");
	await h.session.prompt("Use the non-reasoning model");
	assert.equal(h.states.length, 1);
	await h.session.setModel(getModel("openai", "gpt-5.4"));
	assert.equal(h.session.thinkingLevel, "medium");
	await h.session.prompt("Return to the original model");
	assert.equal(h.states.length, 2);
	assert.equal(h.session.thinkingLevel, "medium");
	assert.equal(h.settings.getDefaultThinkingLevel(), "medium");
	assert.equal(h.settings.getModelThinkingLevel("openai", "gpt-5-mini"), "low");
});

test("real AgentSession delayed model thinking event does not pause adaptation but a manual selection does", async (t) => {
	let release!: () => void;
	let delayed = false;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(() => release());
	const h = await sessionHarness(t, { beforeExtension: (pi) => {
		pi.on("thinking_level_select", async (event) => {
			if (!delayed && event.previousLevel === "medium" && event.level === "low") { delayed = true; await gate; }
		});
	} });
	await h.session.setModel(getModel("openai", "gpt-5-mini"));
	assert.equal(delayed, true);
	release();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(h.session.thinkingLevel, "low");
	await h.session.prompt("/adaptive-reasoning status");
	const status = h.session.messages.filter((message) => message.role === "custom").at(-1);
	assert.equal(status?.role, "custom");
	assert.match(String(status?.content), /Baseline: low\nLease: 0\nPaused: no/);
	h.tools(1, async () => {
		h.session.setThinkingLevel("medium");
		await new Promise<void>((resolve) => setImmediate(resolve));
	});
	await h.session.prompt("Check manual override");
	assert.deepEqual(h.reasoning, ["high", "medium"]);
	assert.equal(h.states.length, 1);
	assert.equal(h.session.thinkingLevel, "medium");
});

test("real AgentSession preserves the final baseline after back-to-back models with delayed thinking events", async (t) => {
	let release!: () => void;
	let delayed = 0;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(() => release());
	const h = await sessionHarness(t, { beforeExtension: (pi) => {
		pi.on("thinking_level_select", async () => { delayed++; await gate; });
	} });
	await h.session.setModel(getModel("openai", "gpt-5-mini"));
	await h.session.setModel(getModel("openai", "gpt-5.4"));
	assert.equal(delayed, 2);
	release();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(h.session.thinkingLevel, "medium");
	await h.session.prompt("/adaptive-reasoning status");
	const status = h.session.messages.filter((message) => message.role === "custom").at(-1);
	assert.match(String(status?.content), /Baseline: medium\nLease: 0\nPaused: no/);
});

test("real AgentSession preserves a manual choice whose thinking event arrives after settling", async (t) => {
	let release!: () => void;
	let delayed = false;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(() => release());
	const h = await sessionHarness(t, { lease: 5, beforeExtension: (pi) => {
		pi.on("thinking_level_select", async (event) => {
			if (!delayed && event.previousLevel === "high" && event.level === "low") { delayed = true; await gate; }
		});
	} });
	h.tools(1, async () => { h.session.setThinkingLevel("low"); });
	await h.session.prompt("Keep my manual selection");
	assert.equal(delayed, true);
	assert.deepEqual(h.reasoning, ["high", "low"]);
	assert.equal(h.states.length, 1);
	assert.equal(h.session.thinkingLevel, "low");
	release();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(h.session.thinkingLevel, "low");
	await h.session.prompt("/adaptive-reasoning status");
	const status = h.session.messages.filter((message) => message.role === "custom").at(-1);
	assert.match(String(status?.content), /Baseline: low\nLease: 0\nPaused: manual override/);
	const persisted = h.session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "adaptive-reasoning").at(-1);
	assert.equal((persisted?.type === "custom" ? persisted.data as { baseline: string } : undefined)?.baseline, "low");
});

test("real AgentSession does not let an already captured delayed manual event pause the next task", async (t) => {
	let release!: () => void;
	let delayed = false;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(() => release());
	const h = await sessionHarness(t, { lease: 1, beforeExtension: (pi) => {
		pi.on("thinking_level_select", async (event) => {
			if (!delayed && event.previousLevel === "high" && event.level === "low") { delayed = true; await gate; }
		});
	} });
	h.tools(1, async () => { h.session.setThinkingLevel("low"); });
	await h.session.prompt("Choose a manual baseline");
	assert.equal(delayed, true);
	assert.equal(h.session.thinkingLevel, "low");
	assert.equal(h.states.length, 1);
	// The generation counter spans both prompts; generation three is the new task's tool turn.
	h.tools(3, async () => {
		release();
		await new Promise<void>((resolve) => setImmediate(resolve));
	});
	await h.session.prompt("Resume adaptation with the same low effort");
	assert.deepEqual(h.reasoning, ["high", "low", "low", "low"]);
	assert.deepEqual(h.states.map((state) => [state.latestUserPrompt, state.step]), [
		["Choose a manual baseline", 0],
		["Resume adaptation with the same low effort", 0],
		["Resume adaptation with the same low effort", 1],
	]);
	await h.session.prompt("/adaptive-reasoning status");
	const status = h.session.messages.filter((message) => message.role === "custom").at(-1);
	assert.match(String(status?.content), /Baseline: low\nLease: 0\nPaused: no/);
});
