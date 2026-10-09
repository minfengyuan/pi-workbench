import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { getModel } from "@earendil-works/pi-ai/compat";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/adaptive-reasoning/index.ts";
let agentDir: string;
const previousDir = process.env.PI_CODING_AGENT_DIR;
before(async () => { agentDir = await mkdtemp(join(tmpdir(), "pi-adaptive-hooks-")); process.env.PI_CODING_AGENT_DIR = agentDir; });
after(async () => {
	if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
	await rm(agentDir, { recursive: true, force: true });
});
const response = (effort = "high", lease = "1") => Response.json({ model: "typesafe/jev-1.13", provider: "TypeSafe", answers: { effort: { type: "choice", choice: effort }, lease: { type: "choice", choice: lease } } });
function harness(delayed = false) {
	const events = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, { handler: (...args: any[]) => any }>();
	const entries: any[] = []; const sent: any[] = []; const pending: (() => void)[] = [];
	let level = "medium", model = getModel("openai", "gpt-5.4");
	const ctx = { model, hasUI: false, isIdle: () => false, hasPendingMessages: () => false,
		modelRegistry: { getApiKeyForProvider: async () => "fake" }, sessionManager: { getBranch: () => entries, buildSessionProjection: () => ({ entries: [], messages: entries.filter((e) => e.type === "message").map((e) => e.message), thinkingLevel: level, model: null }) },
		ui: { setStatus() {}, notify() {}, select: async () => undefined } } as unknown as ExtensionContext;
	const pi = { registerFlag() {}, registerCommand: (name: string, command: any) => commands.set(name, command), getFlag: () => "on",
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
		on: (name: string, fn: any) => events.set(name, fn), appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
		getThinkingLevel: () => level,
		setThinkingLevel: (next: string) => { const previous = level; level = next; if (previous !== next) { const emit = () => events.get("thinking_level_select")?.({ level: next, previousLevel: previous }, ctx); if (delayed) pending.push(emit); else emit(); } },
	} as unknown as ExtensionAPI;
	extension(pi);
	return { ctx, pi, entries, sent, events, commands, get level() { return level; }, flush: () => { while (pending.length) pending.shift()?.(); }, setModel: (next: typeof model) => { model = next; (ctx as any).model = next; }, run: (name: string, event = {}) => events.get(name)?.(event, ctx) };
}
test("delayed own thinking event preserves lease; manual override pauses until next task", async (t) => {
	let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; return response("high", "2"); });
	const h = harness(true); await h.run("session_start"); await h.run("before_agent_start", { prompt: "goal" }); h.flush();
	assert.equal(h.level, "high"); await h.run("turn_end", { message: {}, toolResults: [{ isError: false }] }); assert.equal(calls, 1);
	h.pi.setThinkingLevel("low"); h.flush(); await h.run("turn_end", { message: {}, toolResults: [{}] }); assert.equal(calls, 1); assert.equal(h.level, "low");
	await h.run("before_agent_start", { prompt: "next" }); h.flush(); assert.equal(calls, 2);
	await h.run("agent_settled"); h.flush(); assert.equal(h.level, "low");
});
test("Jev errors restore baseline and pause, then retry next task", async (t) => {
	let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; if (calls === 1) return response(); return new Response("", { status: 401 }); });
	const h = harness(); await h.run("session_start"); await h.run("before_agent_start", { prompt: "goal" }); assert.equal(h.level, "high");
	await h.run("turn_end", { message: {}, toolResults: [{}] }); assert.equal(h.level, "medium");
	await h.run("turn_end", { message: {}, toolResults: [{}] }); assert.equal(calls, 2);
	await h.run("before_agent_start", { prompt: "next" }); assert.equal(calls, 3);
});
test("nonreasoning model never calls Jev; model clamp does not throw", async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("must not call"); });
	const h = harness(); await h.run("session_start"); h.setModel({ ...h.ctx.model!, id: "nonreasoning-fixture", reasoning: false }); h.pi.setThinkingLevel("off");
	await h.run("model_select"); assert.equal(h.level, "off"); await h.run("before_agent_start", { prompt: "goal" }); assert.equal(h.level, "off");
});
test("disabled command cancels delayed evaluation and stale response cannot apply", async (t) => {
	let resolve!: (response: Response) => void;
	t.mock.method(globalThis, "fetch", () => new Promise<Response>((r) => { resolve = r; }));
	const h = harness(); await h.run("session_start"); const evaluating = h.run("before_agent_start", { prompt: "goal" });
	await new Promise((r) => setImmediate(r)); await h.commands.get("adaptive-reasoning")?.handler("off", h.ctx);
	resolve(response()); await evaluating; assert.equal(h.level, "medium");
});
test("queued input restores baseline until the user message has entered the branch", async (t) => {
	let calls = 0; const goals: string[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => { calls++; goals.push(JSON.parse(init?.body as string).state.latestUserPrompt); return response("high", "5"); });
	const h = harness(); h.entries.push({ type: "message", message: { role: "user", content: "first" } });
	await h.run("session_start"); await h.run("before_agent_start", { prompt: "first" }); assert.equal(h.level, "high");
	await h.run("message_end", { message: { role: "user", content: "first" } });
	await h.run("input", { text: "steering" }); assert.equal(h.level, "medium");
	await h.run("turn_end", { message: {}, toolResults: [{}] }); assert.equal(calls, 1);
	const message = { role: "user", content: [{ type: "text", text: "steering" }] };
	await h.run("message_end", { message });
	h.entries.push({ type: "message", message });
	await h.run("turn_end", { message: {}, toolResults: [{}] }); assert.equal(calls, 2); assert.deepEqual(goals, ["first", "steering"]);
});
test("restored branch state selects its baseline and never restores an old lease", async (t) => {
	let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; return response("high", "5"); });
	const h = harness(); h.entries.push({ type: "custom", customType: "adaptive-reasoning", data: { version: 1, enabled: true, baseline: "low" } });
	await h.run("session_start"); assert.equal(h.level, "low");
	await h.run("before_agent_start", { prompt: "goal" }); assert.equal(calls, 1);
	h.entries.splice(0, h.entries.length, { type: "custom", customType: "adaptive-reasoning", data: { version: 1, enabled: true, baseline: "medium" } });
	await h.run("session_tree"); assert.equal(h.level, "medium");
	await h.run("turn_end", { message: {}, toolResults: [{}] }); assert.equal(calls, 2);
});
test("missing credentials disable evaluator without a provider request", async (t) => {
	let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; return response(); });
	const h = harness(); (h.ctx.modelRegistry as any).getApiKeyForProvider = async () => undefined;
	await h.run("session_start"); await h.run("before_agent_start", { prompt: "first" });
	await h.run("before_agent_start", { prompt: "second" }); assert.equal(calls, 0); assert.equal(h.level, "medium");
});

test("multiple delayed own transitions cannot replace manual baseline", async (t) => {
	let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; return response(calls === 1 ? "low" : "high", "2"); });
	const h = harness(true); await h.run("session_start"); await h.run("before_agent_start", { prompt: "first" }); h.flush(); assert.equal(h.level, "low");
	await h.run("before_agent_start", { prompt: "second" }); h.flush(); assert.equal(h.level, "high");
	await h.run("turn_end", { message: {}, toolResults: [{}] }); assert.equal(calls, 2);
	await h.run("agent_settled"); h.flush(); assert.equal(h.level, "medium");
});

test("headless status emits a display message without triggering the agent", async () => {
	const h = harness(); await h.run("session_start");
	await h.commands.get("adaptive-reasoning")?.handler("", h.ctx);
	assert.equal(h.sent.length, 1); assert.match(h.sent[0].message.content, /Evaluator: OpenRouter/);
	assert.equal(h.sent[0].message.display, true); assert.equal(h.sent[0].options.triggerTurn, false);
});


test("late manual notification cannot allow an in-flight decision to overwrite the user's level", async (t) => {
	let resolve!: (response: Response) => void;
	t.mock.method(globalThis, "fetch", () => new Promise<Response>((r) => { resolve = r; }));
	const h = harness(true); await h.run("session_start");
	const evaluating = h.run("before_agent_start", { prompt: "goal" });
	await new Promise((r) => setImmediate(r));
	h.pi.setThinkingLevel("low");
	resolve(response("high")); await evaluating;
	assert.equal(h.level, "low");
	h.flush(); await h.run("agent_settled"); h.flush();
	assert.equal(h.level, "low");
});


test("invalid global configuration disables evaluation despite an on flag", async (t) => {
	let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; return response(); });
	const path = join(agentDir, "adaptive-reasoning.yaml");
	await writeFile(path, "enabled: true\nmaxLeaseSteps: 3\n");
	try {
		const h = harness(); await h.run("session_start");
		await h.run("before_agent_start", { prompt: "goal" });
		await h.commands.get("adaptive-reasoning")?.handler("on", h.ctx);
		assert.equal(calls, 0); assert.equal(h.level, "medium");
		assert.ok(h.sent.some((item) => item.message.content.includes("Invalid adaptive reasoning config")));
	} finally { await rm(path); }
});

test("a no-change model switch cannot swallow a later manual thinking change", async () => {
	const h = harness(); await h.run("session_start");
	h.setModel({ ...h.ctx.model!, id: "another-reasoning-model" });
	await h.run("model_select"); assert.equal(h.level, "medium");
	h.pi.setThinkingLevel("off");
	await h.run("agent_settled"); assert.equal(h.level, "off");
});

for (const delayed of [false, true]) test(`model-selected baseline survives automatic thinking events (delayed=${delayed})`, async (t) => {
	let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; return response("high", "2"); });
	const h = harness(delayed); await h.run("session_start");
	await h.run("before_agent_start", { prompt: "first" }); h.flush();
	h.setModel({ ...h.ctx.model!, id: "another-reasoning-model" });
	h.pi.setThinkingLevel("low"); await h.run("model_select"); h.flush();
	assert.equal(h.level, "low");
	await h.run("turn_end", { message: {}, toolResults: [{}] }); h.flush();
	assert.equal(calls, 2); assert.equal(h.level, "high");
	await h.run("agent_settled"); h.flush(); assert.equal(h.level, "low");
	h.pi.setThinkingLevel("medium"); h.flush();
	await h.run("agent_settled"); h.flush(); assert.equal(h.level, "medium");
});


test("disabling cancels evaluation even while Pi credential resolution is pending", async (t) => {
	let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; return response(); });
	const h = harness();
	let resolve!: (key: string) => void;
	(h.ctx.modelRegistry as any).getApiKeyForProvider = () => new Promise<string>((r) => { resolve = r; });
	await h.run("session_start");
	const evaluating = h.run("before_agent_start", { prompt: "goal" });
	await new Promise((r) => setImmediate(r));
	await h.commands.get("adaptive-reasoning")?.handler("off", h.ctx);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try { await Promise.race([evaluating, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Evaluation failed to cancel")), 100); })]); }
	finally { clearTimeout(timeout); resolve("fake"); }
	assert.equal(h.level, "medium"); assert.equal(calls, 0);
});
test("evaluator history follows Pi's session projection, not raw branch entries", async (t) => {
	const bodies: any[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => { bodies.push(JSON.parse(init?.body as string)); return response("high", "1"); });
	const sm = SessionManager.inMemory(agentDir);
	const user = (text: string) => ({ role: "user", content: text, timestamp: Date.now() }) as any;
	const assistant = (text: string) => ({ role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE-THOUGHT" }, { type: "text", text }], api: "openai-responses", provider: "openai", model: "gpt-5.4", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() }) as any;
	sm.appendMessage(user("COMPACTED-AWAY goal")); sm.appendMessage(assistant("COMPACTED-AWAY note"));
	const kept = sm.appendMessage(user("kept goal"));
	sm.appendCompaction("summary", kept, 1000);
	const secret = sm.appendMessage(user("OMITTED-SECRET goal"));
	const replaced = sm.appendMessage(assistant("REPLACED-ORIGINAL note"));
	sm.appendContextEdit(secret, null);
	sm.appendContextEdit(replaced, { content: "replacement note" });
	sm.appendMessage(user("current goal"));
	const h = harness(); (h.ctx as any).sessionManager = sm;
	await h.run("session_start"); await h.run("before_agent_start", { prompt: "current goal" });
	assert.equal(bodies.length, 1);
	const state = bodies[0].state, json = JSON.stringify(state);
	assert.deepEqual(state.priorUserPrompts, ["kept goal"]);
	assert.deepEqual(state.publicNotes, ["replacement note"]);
	assert.equal(state.latestUserPrompt, "current goal");
	for (const hidden of ["COMPACTED-AWAY", "OMITTED-SECRET", "REPLACED-ORIGINAL", "PRIVATE-THOUGHT", "summary"]) assert.equal(json.includes(hidden), false, hidden);
});
test("long sessions keep the evaluator working with a bounded request body", async (t) => {
	const bodies: string[] = [];
	t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => { bodies.push(init?.body as string); return response("high", "1"); });
	const h = harness();
	for (let i = 0; i < 200; i++) {
		h.entries.push({ type: "message", message: { role: "user", content: `prompt ${i} ${"detail ".repeat(1_500)}` } });
		h.entries.push({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE" }, { type: "text", text: `answer ${i} ${"public ".repeat(1_500)}` }] } });
	}
	h.entries.push({ type: "message", message: { role: "user", content: "final goal" } });
	await h.run("session_start"); await h.run("before_agent_start", { prompt: "final goal" });
	assert.equal(bodies.length, 1); assert.equal(h.level, "high");
	const body = bodies[0], state = JSON.parse(body).state;
	assert.ok(countTokens(body, { disallowedSpecial: new Set() }) <= 28_000);
	assert.match(state.priorUserPrompts.at(-1), /^prompt 199 /); assert.match(state.publicNotes.at(-1), /^answer 199 /);
	assert.ok(state.omittedOlderUserPrompts > 0 && state.omittedOlderPublicNotes > 0);
	assert.equal(body.includes("PRIVATE"), false);
});
