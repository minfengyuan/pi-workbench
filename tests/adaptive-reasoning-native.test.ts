import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { decisionRequest, JevClient } from "../extensions/adaptive-reasoning/jev.ts";
import { NATIVE_JEV, nativeClassifierContext, nativeDecide, NativeJevError, PROVIDER_PINNING } from "../extensions/adaptive-reasoning/native.ts";

const state = { model: "openai/gpt-5.4", supportedEfforts: ["none", "low", "high"], latestUserPrompt: "goal", compactionSummary: "", priorUserPrompts: [], omittedOlderUserPrompts: 0, publicNotes: [], omittedOlderPublicNotes: 0, recentToolCalls: [], omittedOlderToolCalls: 0, step: 0, previousEffort: "low", newToolFailures: 0 };
const answers = (effort = "high", lease = "2") => ({ effort: { type: "choice", choice: effort, probabilities: { [effort]: 0.9 }, confidence: 0.9 }, lease: { type: "choice", choice: lease, probabilities: { [lease]: 0.8 }, confidence: 0.8 } });
async function runtime() {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openrouter", async () => ({ type: "api_key", key: "fake-key" }));
	return ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
}
function recorder(respond: () => Response) {
	const calls: { url: string; init: RequestInit; body: any }[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init!, body: JSON.parse(init!.body as string) }); return respond(); }) as typeof fetch;
	return { calls, fetchImpl };
}

test("Pi 1.1.0 catalog exposes Jev 1.13 as an OpenRouter System One classifier", async () => {
	const model = (await runtime()).getModelOfType("classifier", NATIVE_JEV.provider, NATIVE_JEV.id);
	assert.equal(model?.api, "typesafe-system-one"); assert.equal(model?.baseUrl, "https://openrouter.ai/api/v1");
});
test("native path sends the same state/questions to a different endpoint, with best-effort pinning", async () => {
	const native = recorder(() => Response.json({ answers: answers(), usage: { input_tokens: 1_000, output_tokens: 3 } }));
	const { decision, result } = await nativeDecide(await runtime(), state, 10, { fetch: native.fetchImpl });
	assert.deepEqual(decision, { level: "high", leaseSteps: 2 });
	assert.equal(native.calls[0].url, "https://openrouter.ai/api/v1/systemone");
	assert.equal(native.calls[0].body.model, "typesafe/jev-1.13");
	assert.deepEqual(native.calls[0].body.provider, PROVIDER_PINNING);
	assert.equal((native.calls[0].init.headers as Record<string, string>).authorization, "Bearer fake-key");

	const http = recorder(() => Response.json({ model: "typesafe/jev-1.13", provider: "TypeSafe", answers: answers() }));
	await new JevClient(http.fetchImpl).decide(state, "fake-key", 10);
	assert.equal(http.calls[0].url, "https://openrouter.ai/api/alpha/decisions");
	assert.equal(http.calls[0].init.redirect, "error");
	assert.equal(native.calls[0].init.redirect, undefined, "native path follows redirects (documented gap)");
	assert.deepEqual(native.calls[0].body.state, http.calls[0].body.state);
	assert.deepEqual(native.calls[0].body.questions, http.calls[0].body.questions);
	assert.deepEqual(http.calls[0].body.provider, PROVIDER_PINNING);
	// Native usage: tokens and catalog cost; the result reports the requested model, not the server's.
	assert.equal(result.usage?.input, 1_000); assert.equal(result.usage?.output, 3); assert.equal(result.usage?.cacheRead, 0);
	assert.ok(Math.abs(result.usage!.cost.total - 0.042 / 1_000) < 1e-12);
	assert.equal(result.provider, "openrouter"); assert.equal(result.model, "typesafe/jev-1.13");
});
test("native path cannot detect a non-TypeSafe upstream; the HTTP client rejects it", async () => {
	const body = { model: "other/model", provider: "Fallback", answers: answers() };
	const native = recorder(() => Response.json(body));
	assert.deepEqual((await nativeDecide(await runtime(), state, 10, { fetch: native.fetchImpl })).decision, { level: "high", leaseSteps: 2 });
	await assert.rejects(new JevClient(recorder(() => Response.json(body)).fetchImpl).decide(state, "fake-key", 10), /invalid model, provider/);
});
test("native answer parsing is stricter and range checks still apply", async () => {
	const missingProbabilities = recorder(() => Response.json({ answers: { effort: { type: "choice", choice: "high" }, lease: { type: "choice", choice: "2" } } }));
	await assert.rejects(nativeDecide(await runtime(), state, 10, { fetch: missingProbabilities.fetchImpl }), NativeJevError);
	const unsupported = recorder(() => Response.json({ answers: answers("max", "10"), usage: { input_tokens: 5 } }));
	const error = await nativeDecide(await runtime(), state, 2, { fetch: unsupported.fetchImpl }).catch((e) => e);
	assert.ok(error instanceof NativeJevError); assert.match(error.message, /invalid effort or lease/);
	assert.equal(error.result?.usage?.input, 5, "billed usage survives an invalid answer");
});
test("native errors become results: 4xx is not retried, 5xx is retried up to three attempts", async () => {
	const bad = recorder(() => new Response("nope", { status: 400 }));
	const error = await nativeDecide(await runtime(), state, 10, { fetch: bad.fetchImpl }).catch((e) => e);
	assert.ok(error instanceof NativeJevError); assert.equal(error.result?.stopReason, "error"); assert.equal(bad.calls.length, 1);
	let n = 0; const flaky = recorder(() => ++n < 3 ? new Response("busy", { status: 503 }) : Response.json({ answers: answers("low", "1") }));
	assert.deepEqual((await nativeDecide(await runtime(), state, 10, { fetch: flaky.fetchImpl })).decision, { level: "low", leaseSteps: 1 });
	assert.equal(flaky.calls.length, 3);
});
test("native abort is reported as aborted without a decision", async () => {
	const controller = new AbortController(); controller.abort();
	const never = recorder(() => Response.json({ answers: answers() }));
	const error = await nativeDecide(await runtime(), state, 10, { fetch: never.fetchImpl, signal: controller.signal }).catch((e) => e);
	assert.ok(error instanceof NativeJevError); assert.equal(error.result?.stopReason, "aborted");
});
test("native adapter keeps the local request budget", async () => {
	const never = recorder(() => Response.json({ answers: answers() }));
	await assert.rejects(nativeDecide(await runtime(), { ...state, latestUserPrompt: "a ".repeat(30_000) }, 10, { fetch: never.fetchImpl }), /budget/);
	assert.equal(never.calls.length, 0);
	assert.deepEqual(nativeClassifierContext(state, 10).questions, (decisionRequest(state, 10) as any).questions);
});
