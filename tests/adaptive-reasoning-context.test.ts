import assert from "node:assert/strict";
import test from "node:test";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { buildEvaluatorState, serializeRequest, truncateToolResult } from "../extensions/adaptive-reasoning/context.ts";
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
