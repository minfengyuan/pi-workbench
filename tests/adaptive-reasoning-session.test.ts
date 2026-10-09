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

