import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
test("comparison defaults to offline without credentials, network or workspace mutations", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-comparison-test-"));
	try {
		await run("git", ["init", root]);
		await writeFile(join(root, "fixture.txt"), "clean workload baseline");
		await run("git", ["-C", root, "add", "fixture.txt"]);
		await run("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "test: fixture"]);
		const workload = join(root, "workload.json");
		await writeFile(workload, JSON.stringify({ repository: root, provider: "not-configured", model: "not-configured", tasks: [{ name: "bounded-fix", prompt: "Fix the fixture", verify: { command: "false", args: [] } }] }));
		const preload = join(root, "no-network.mjs");
		await writeFile(preload, 'globalThis.fetch = () => { throw new Error("offline network attempted"); };');
		const before = (await run("git", ["-C", root, "status", "--porcelain"])).stdout;
		const { stdout } = await run(process.execPath, ["--import", pathToFileURL(preload).href, "scripts/compare-adaptive-reasoning.mjs", workload], { env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "nonexistent-agent"), PI_OFFLINE: "1" } });
		const plan = JSON.parse(stdout);
		assert.equal(plan.live, false);
		assert.deepEqual(plan.variants, ["medium", "high", "adaptive"]);
		assert.deepEqual(plan.tasks, ["bounded-fix"]);
		assert.match(plan.commit, /^[a-f0-9]{40}$/);
		assert.equal((await run("git", ["-C", root, "status", "--porcelain"])).stdout, before);
		await assert.rejects(readFile(join(root, "nonexistent-agent", "auth.json")));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("comparison rejects ambiguous live flags and malformed workload", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-comparison-test-"));
	try {
		const workload = join(root, "workload.json");
		await writeFile(workload, "{}");
		await assert.rejects(run(process.execPath, ["scripts/compare-adaptive-reasoning.mjs", workload, "--liv"]));
		await assert.rejects(run(process.execPath, ["scripts/compare-adaptive-reasoning.mjs", workload]));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("live comparison plumbing uses clean clones and records fake-provider usage without real network", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-comparison-live-test-"));
	try {
		await run("git", ["init", root]);
		await writeFile(join(root, "baseline.txt"), "baseline");
		await run("git", ["-C", root, "add", "baseline.txt"]);
		await run("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "test: fixture"]);
		await writeFile(join(root, "baseline.txt"), "dirty content excluded");
		const workload = join(root, "workload.json");
		await writeFile(workload, JSON.stringify({ repository: root, provider: "openai", model: "gpt-5.4", tasks: [{ name: "fake-write", prompt: "Write result.txt", verify: { command: "node", args: ["-e", "const a=require('node:assert/strict'),f=require('node:fs');a.equal(f.readFileSync('result.txt','utf8'),'ok');a.equal(f.readFileSync('baseline.txt','utf8'),'baseline')"] } }] }));
		const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
		const ai = import.meta.resolve("@earendil-works/pi-ai");
		const preload = join(root, "fake-providers.mjs");
		await writeFile(preload, `
import { ModelRuntime } from ${JSON.stringify(sdk)};
import { InMemoryCredentialStore, createAssistantMessageEventStream } from ${JSON.stringify(ai)};
const create = ModelRuntime.create.bind(ModelRuntime);
ModelRuntime.create = async () => {
 const credentials = new InMemoryCredentialStore();
 for (const id of ['openai','openrouter']) await credentials.modify(id, async () => ({type:'api_key',key:'fake'}));
 const runtime = await create({credentials,modelsPath:null,refreshOnCreate:false});
 runtime.streamSimple = (model,context,options) => {
  const complete = context.messages.some(m=>m.role==='toolResult');
  const reasoning = {medium:2,high:5,low:1}[options.reasoning] ?? 0;
  const message = {role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:complete?[{type:'text',text:'done'}]:[{type:'toolCall',id:'write-fixture',name:'write',arguments:{path:'result.txt',content:'ok'}}],stopReason:complete?'stop':'toolUse',usage:{input:1,output:reasoning,reasoning,cacheRead:0,cacheWrite:0,totalTokens:1+reasoning,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:message.stopReason,message});return stream;
 };
 return runtime;
};
globalThis.fetch = async (url) => {
 if(String(url)!=='https://openrouter.ai/api/alpha/decisions')throw new Error('Unexpected network');
 return Response.json({model:'typesafe/jev-1.13',provider:'TypeSafe',answers:{effort:{type:'choice',choice:'low'},lease:{type:'choice',choice:'1'}},usage:{cost:0.01,prompt_tokens:300,completion_tokens:1}});
};
`);
		const { stdout } = await run(process.execPath, ["--import", pathToFileURL(preload).href, "scripts/compare-adaptive-reasoning.mjs", workload, "--live"], { env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "nonexistent-agent"), PI_OFFLINE: "1" } });
		const result = JSON.parse(stdout);
		assert.deepEqual(result.results.map((row: any) => row.success), [true, true, true]);
		assert.deepEqual(result.results.map((row: any) => row.reasoningTokens), [4, 10, 2]);
		assert.deepEqual(result.results.map((row: any) => row.jevCalls), [0, 0, 2]);
		assert.equal(result.results[2].jevReportedCost, 0.02);
		assert.deepEqual(result.results.map((row: any) => [row.jevInputTokens, row.jevOutputTokens]), [[0, 0], [0, 0], [600, 2]]);
		assert.ok(result.results.every((row: any) => Number.isInteger(row.jevLatencyMs)));
		assert.equal(await readFile(join(root, "baseline.txt"), "utf8"), "dirty content excluded");
		await assert.rejects(readFile(join(root, "result.txt")));
	} finally { await rm(root, { recursive: true, force: true }); }
});
