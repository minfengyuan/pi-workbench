import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = "scripts/benchmark-jev-paths.mjs";
test("Jev path benchmark defaults to an offline plan without credentials or network", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-jev-bench-"));
	try {
		const preload = join(root, "no-network.mjs");
		await writeFile(preload, 'globalThis.fetch = () => { throw new Error("offline network attempted"); };');
		const { stdout } = await run(process.execPath, ["--import", pathToFileURL(preload).href, script, "scripts/jev-cases.example.json", "--repeat", "2"], { env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "none") } });
		const plan = JSON.parse(stdout);
		assert.equal(plan.live, false); assert.deepEqual(plan.paths, ["http", "native"]); assert.equal(plan.requests, 12);
		assert.deepEqual(plan.endpoints, { http: "https://openrouter.ai/api/alpha/decisions", native: "https://openrouter.ai/api/v1/systemone" });
	} finally { await rm(root, { recursive: true, force: true }); }
});
test("Jev path benchmark rejects malformed cases and flags", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-jev-bench-"));
	try {
		const bad = join(root, "cases.json");
		await writeFile(bad, JSON.stringify({ cases: [{ name: "x", metadata: { supportedEfforts: ["bogus"] } }] }));
		await assert.rejects(run(process.execPath, [script, bad]), /unsupported efforts/);
		await assert.rejects(run(process.execPath, [script, "scripts/jev-cases.example.json", "--liv"]));
		await assert.rejects(run(process.execPath, [script, "scripts/jev-cases.example.json", "--live"], { env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "none"), OPENROUTER_API_KEY: "" } }), /no OpenRouter credential/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
test("live benchmark compares both paths on latency, structure, accuracy and usage with fake providers", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-jev-bench-live-"));
	try {
		const cases = join(root, "cases.json");
		await writeFile(cases, JSON.stringify({ maxLeaseSteps: 10, cases: [
			{ name: "agree", metadata: { latestUserPrompt: "easy" }, expect: { effort: ["low"], lease: ["2"] } },
			{ name: "fallback", metadata: { latestUserPrompt: "fallback" }, expect: { effort: ["high"] } },
		] }));
		const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
		const ai = import.meta.resolve("@earendil-works/pi-ai");
		const preload = join(root, "fake.mjs");
		await writeFile(preload, `
import { ModelRuntime } from ${JSON.stringify(sdk)};
import { InMemoryCredentialStore } from ${JSON.stringify(ai)};
const create = ModelRuntime.create.bind(ModelRuntime);
ModelRuntime.create = async (options) => { const credentials = new InMemoryCredentialStore(); await credentials.modify('openrouter', async () => ({ type: 'api_key', key: 'fake' })); return create({ ...options, credentials }); };
const answer = (c, p) => ({ type: 'choice', choice: c, probabilities: { [c]: p }, confidence: p });
globalThis.fetch = async (url, init) => {
 const body = JSON.parse(init.body); const fallback = body.state.latestUserPrompt === 'fallback';
 const answers = fallback ? { effort: answer('high', 0.7), lease: answer('1', 0.6) } : { effort: answer('low', 0.9), lease: answer('2', 0.8) };
 if (String(url) === 'https://openrouter.ai/api/alpha/decisions') return Response.json({ model: fallback ? 'other/model' : 'typesafe/jev-1.13', provider: fallback ? 'Fallback' : 'TypeSafe', answers, usage: { prompt_tokens: 100, completion_tokens: 2, cost: 0.001 } });
 if (String(url) === 'https://openrouter.ai/api/v1/systemone') return Response.json({ model: 'typesafe/jev-1.13', provider: fallback ? 'Fallback' : 'TypeSafe', answers, usage: { input_tokens: 1000, output_tokens: 0, cost: 0.002 } });
 throw new Error('Unexpected network ' + url);
};`);
		const { stdout } = await run(process.execPath, ["--import", pathToFileURL(preload).href, script, cases, "--live"], { env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "none") } });
		const report = JSON.parse(stdout);
		assert.equal(report.results.length, 4);
		const { http, native, agreement } = report.summary;
		// HTTP refuses the non-TypeSafe upstream; native cannot tell and accepts it.
		assert.equal(http.ok, 1); assert.deepEqual(http.errors, { "invalid-answer": 1 }); assert.equal(native.ok, 2);
		assert.equal(http.effortAccuracy, 0.5); assert.equal(native.effortAccuracy, 1); assert.equal(native.leaseAccuracy, 1);
		assert.equal(http.servedByTypeSafe, 1); assert.equal(native.servedByTypeSafe, 1);
		assert.deepEqual(agreement, { comparable: 1, sameEffort: 1, sameLease: 1 });
		assert.equal(http.usage.inputTokens, 100); assert.equal(http.usage.outputTokens, 2); assert.equal(http.usage.reportedCost, 0.002); assert.equal(http.usage.catalogCost, null);
		assert.equal(native.usage.inputTokens, 2000); assert.equal(native.usage.reportedCost, 0.004);
		assert.ok(Math.abs(native.usage.catalogCost - 2 * 0.042 / 1000) < 1e-12);
		for (const row of report.results) { assert.equal(typeof row.latencyMs, "number"); assert.equal(row.attempts, 1); assert.deepEqual(row.structure, { choiceAnswers: true, probabilities: true, confidence: true }); }
		assert.ok(native.latencyMs.p50 !== null && native.latencyMs.p95 !== null);
		assert.equal(stdout.includes("fake"), false, "credentials are never printed");
	} finally { await rm(root, { recursive: true, force: true }); }
});
