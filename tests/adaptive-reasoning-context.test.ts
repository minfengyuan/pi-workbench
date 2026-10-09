import assert from "node:assert/strict";
import test from "node:test";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { buildEvaluatorState, CONTEXT_BUDGETS, newestWithinBudget, serializeRequest, truncateToolResult } from "../extensions/adaptive-reasoning/context.ts";
import { decisionRequest } from "../extensions/adaptive-reasoning/jev.ts";
const metadata = { model: "test", supportedEfforts: ["low", "high"], latestUserPrompt: "goal", step: 1, previousEffort: "low", newToolFailures: 0 };
test("context projects public text and six recent calls; excludes private and binary payloads", () => {
	const messages: unknown[] = [{ role: "user", content: "goal" }];
	for (let i = 0; i < 8; i++) messages.push({ role: "assistant", headers: { authorization: "SECRET" }, content: [{ type: "thinking", thinking: "PRIVATE" }, { type: "text", text: "public" }, { type: "toolCall", id: `${i}`, name: "read", arguments: { path: `${i}` } }] }, { role: "toolResult", toolCallId: `${i}`, content: [{ type: "image", data: "BINARY" }, { type: "text", text: `result ${i}` }], isError: i === 7 });
	const state = buildEvaluatorState(messages, metadata), json = JSON.stringify(state);
	assert.equal(state.recentToolCalls.length, 6); assert.equal(state.omittedOlderToolCalls, 2);
	assert.equal(state.recentToolCalls[5].isError, true); assert.equal(state.recentToolCalls[0].result, "result 2");
	for (const secret of ["PRIVATE", "BINARY", "SECRET", "authorization"]) assert.equal(json.includes(secret), false);
});
test("tool results retain head and tail within 1000 tokens", () => {
	const result = truncateToolResult("HEAD " + "middle ".repeat(10_000) + " TAIL");
	assert.ok(result.startsWith("HEAD")); assert.ok(result.endsWith("TAIL")); assert.match(result, /middle omitted/);
	assert.ok(countTokens(result, { disallowedSpecial: new Set() }) <= 1000);
});
test("whole request budgets reject oversized goals and byte-heavy context locally", () => {
	assert.throws(() => serializeRequest({ goal: "a ".repeat(30_000) }), /budget/);
	assert.throws(() => serializeRequest({ goal: " ".repeat(2_100_000) }), /budget/);
});
const tokens = (text: string) => countTokens(text, { disallowedSpecial: new Set() });
const sum = (items: string[]) => items.reduce((total, item) => total + tokens(item), 0);
function longSession(turns: number, words = 2_000): unknown[] {
	const messages: unknown[] = [];
	for (let i = 0; i < turns; i++) {
		messages.push({ role: "user", content: `USER-${i}-HEAD ${"ask ".repeat(words)} USER-${i}-TAIL` });
		messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE ".repeat(words) }, { type: "text", text: `NOTE-${i}-HEAD ${"say ".repeat(words)} NOTE-${i}-TAIL` }, { type: "toolCall", id: `c${i}`, name: "bash", arguments: { cmd: "x ".repeat(words) } }] });
		messages.push({ role: "toolResult", toolCallId: `c${i}`, content: [{ type: "text", text: "out ".repeat(words) }], isError: false });
	}
	return messages;
}
test("long sessions budget user history and public assistant text, keeping the newest", () => {
	const state = buildEvaluatorState(longSession(300), { ...metadata, latestUserPrompt: "current" });
	assert.ok(sum(state.priorUserPrompts) <= CONTEXT_BUDGETS.priorUserPrompts);
	assert.ok(sum(state.publicNotes) <= CONTEXT_BUDGETS.publicNotes);
	for (const item of [...state.priorUserPrompts, ...state.publicNotes]) { assert.ok(tokens(item) <= CONTEXT_BUDGETS.historyItem); assert.match(item, /\[Text truncated: middle omitted\]/); }
	assert.match(state.priorUserPrompts.at(-1)!, /^USER-299-HEAD[\s\S]*USER-299-TAIL$/);
	assert.match(state.publicNotes.at(-1)!, /^NOTE-299-HEAD[\s\S]*NOTE-299-TAIL$/);
	assert.equal(state.priorUserPrompts.length + state.omittedOlderUserPrompts, 300);
	assert.equal(state.publicNotes.length + state.omittedOlderPublicNotes, 300);
	assert.ok(state.omittedOlderUserPrompts > 290 && state.omittedOlderPublicNotes > 290);
	assert.equal(JSON.stringify(state).includes("PRIVATE"), false);
});
test("worst-case long session still serializes within the request budget", () => {
	const huge = "goal ".repeat(50_000);
	const state = buildEvaluatorState([...longSession(500, 5_000), { role: "user", content: huge }], { ...metadata, latestUserPrompt: huge, supportedEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] });
	assert.ok(tokens(state.latestUserPrompt) <= CONTEXT_BUDGETS.latestUserPrompt); assert.match(state.latestUserPrompt, /middle omitted/);
	assert.equal(state.recentToolCalls.length, 6); assert.equal(state.omittedOlderToolCalls, 494);
	const body = serializeRequest(decisionRequest(state, 10));
	assert.ok(tokens(body) <= 28_000); assert.ok(Buffer.byteLength(body) <= 2_100_000);
});
test("escape-heavy history is shed oldest-first before the request budget fails closed", () => {
	const escaped = "\u0001".repeat(4_000);
	const messages: unknown[] = [];
	for (let i = 0; i < 20; i++) messages.push({ role: "user", content: `u${i} ${escaped}` }, { role: "assistant", content: [{ type: "text", text: `n${i} ${escaped}` }, { type: "toolCall", id: `c${i}`, name: "t", arguments: { x: escaped } }] }, { role: "toolResult", toolCallId: `c${i}`, content: [{ type: "text", text: escaped }] });
	const state = buildEvaluatorState(messages, { ...metadata, latestUserPrompt: "current" });
	assert.ok(tokens(JSON.stringify(state)) <= CONTEXT_BUDGETS.stateTokens);
	// Per-item budgets alone would keep several notes/prompts; JSON escaping forces shedding.
	assert.equal(state.publicNotes.length, 0); assert.equal(state.priorUserPrompts.length, 0); assert.ok(state.recentToolCalls.length < 6);
	assert.equal(state.publicNotes.length + state.omittedOlderPublicNotes, 20);
	assert.equal(state.recentToolCalls.length + state.omittedOlderToolCalls, 20);
	assert.equal(state.recentToolCalls.at(-1)?.name, "t");
	assert.doesNotThrow(() => serializeRequest(decisionRequest(state, 10)));
	// Metadata alone can still exceed the request budget; that remains a local rejection.
	assert.throws(() => serializeRequest(decisionRequest({ ...state, latestUserPrompt: "\u0001".repeat(30_000) }, 10)), /budget/);
});
test("latest prompt is not duplicated and empty user text is not projected", () => {
	const state = buildEvaluatorState([{ role: "user", content: "" }, { role: "user", content: "earlier" }, { role: "user", content: "goal" }], metadata);
	assert.deepEqual(state.priorUserPrompts, ["earlier"]); assert.equal(state.omittedOlderUserPrompts, 0);
});
test("newestWithinBudget keeps chronological order and counts omissions", () => {
	const result = newestWithinBudget(["a", "b", "c ".repeat(2_000)], 1_000, 1_000);
	assert.equal(result.kept.length, 1); assert.equal(result.omitted, 2); assert.ok(tokens(result.kept[0]) <= 1_000);
	assert.deepEqual(newestWithinBudget(["a", "b"], 1_000).kept, ["a", "b"]);
});
