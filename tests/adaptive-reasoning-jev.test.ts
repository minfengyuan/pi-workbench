import assert from "node:assert/strict";
import test from "node:test";
import { decisionRequest, JevClient, validateDecision } from "../extensions/adaptive-reasoning/jev.ts";
const state = { model: "test", supportedEfforts: ["low", "high"], latestUserPrompt: "goal", compactionSummary: "", priorUserPrompts: [], omittedOlderUserPrompts: 0, publicNotes: [], omittedOlderPublicNotes: 0, recentToolCalls: [], omittedOlderToolCalls: 0, step: 0, previousEffort: "medium", newToolFailures: 0 };
const valid = { model: "typesafe/jev-1.13", provider: "TypeSafe", answers: { effort: { type: "choice", choice: "high" }, lease: { type: "choice", choice: "2" } } };
test("typed decisions pin provider and use only supported choices", async () => {
	const request = decisionRequest(state, 2) as any;
	assert.deepEqual(request.provider, { only: ["typesafe"], allow_fallbacks: false });
	assert.deepEqual(Object.keys(request.questions.effort.criteria), ["low", "high"]);
	assert.deepEqual(Object.keys(request.questions.lease.criteria), ["1", "2"]);
	const client = new JevClient(async (url, init) => {
		assert.equal(url, "https://openrouter.ai/api/alpha/decisions"); assert.equal(init?.redirect, "error");
		assert.deepEqual(JSON.parse(init?.body as string), request); return Response.json(valid);
	});
	assert.deepEqual(await client.decide(state, "fake", 2), { level: "high", leaseSteps: 2 });
});
test("invalid provider, model, effort, answer type and lease are rejected", () => {
	for (const change of [{ provider: "Other" }, { model: "typesafe/other" }, { answers: { ...valid.answers, effort: { type: "choice", choice: "max" } } }, { answers: { ...valid.answers, effort: { type: "text", choice: "high" } } }, { answers: { ...valid.answers, lease: { type: "choice", choice: "3" } } }]) assert.throws(() => validateDecision({ ...valid, ...change }, state.supportedEfforts, 10));
	assert.throws(() => validateDecision(valid, state.supportedEfforts, 1));
});
test("HTTP retries are bounded; authentication and network failures are terminal", async () => {
	let calls = 0;
	const retry = new JevClient(async () => { calls++; return new Response("", { status: 503 }); });
	await assert.rejects(retry.decide(state, "fake", 10)); assert.equal(calls, 3);
	calls = 0;
	const auth = new JevClient(async () => { calls++; return new Response("", { status: 401 }); });
	await assert.rejects(auth.decide(state, "fake", 10)); assert.equal(calls, 1);
});
test("oversized request makes zero network calls and cancellation/timeout interrupt fetch", async () => {
	let calls = 0;
	const fetchImpl: typeof fetch = async (_url, init) => { calls++; return new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }); }); };
	const client = new JevClient(fetchImpl, 10);
	await assert.rejects(client.decide({ ...state, latestUserPrompt: "a ".repeat(30_000) }, "fake", 10)); assert.equal(calls, 0);
	const hold = setTimeout(() => {}, 100);
	try { await assert.rejects(client.decide(state, "fake", 10), /timeout/i); }
	finally { clearTimeout(hold); }
	const abort = new AbortController(); abort.abort();
	await assert.rejects(client.decide(state, "fake", 10, abort.signal)); assert.equal(calls, 1);
});
