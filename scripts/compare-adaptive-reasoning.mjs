import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, readStoredCredential, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);
const variants = ["medium", "high", "adaptive"];
const args = process.argv.slice(2);
if (args.includes("--help") || !args.length) {
	console.log("Usage: npm run compare:adaptive -- workload.json [--live]\nDefault: offline comparison plan. --live runs billable models and host tools in disposable clones.");
} else {
	try { await main(); }
	catch { console.error("Comparison failed; check workload, model credentials and local Git. Provider responses and credentials are not printed."); process.exitCode = 1; }
}

async function main() {
	if (args.length > 2 || (args.length === 2 && args[1] !== "--live")) throw new Error("Invalid arguments");
	const specPath = resolve(args[0]);
	const spec = JSON.parse(await readFile(specPath, "utf8"));
	if (typeof spec.repository !== "string" || typeof spec.provider !== "string" || typeof spec.model !== "string" ||
		!Array.isArray(spec.tasks) || !spec.tasks.length || spec.tasks.some((task) => typeof task.name !== "string" || typeof task.prompt !== "string" || !task.prompt.trim() ||
			typeof task.verify?.command !== "string" || !Array.isArray(task.verify.args) || task.verify.args.some((arg) => typeof arg !== "string"))) throw new Error("Invalid workload");
	const repository = resolve(dirname(specPath), spec.repository);
	const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
	const git = (cwd, argv) => run("git", ["-c", "core.hooksPath=/dev/null", ...argv], { cwd, env: gitEnv, maxBuffer: 1024 * 1024 });
	const commit = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
	const plan = { live: args[1] === "--live", provider: spec.provider, model: spec.model, commit, tasks: spec.tasks.map((task) => task.name), variants };
	if (!plan.live) { console.log(JSON.stringify(plan, null, 2)); return; }

	const credentialDir = getAgentDir();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalFetch = globalThis.fetch;
	const stored = Object.fromEntries([spec.provider, "openrouter"].map((id) => [id, readStoredCredential(id, join(credentialDir, "auth.json"))]));
	const credentials = {
		async read(id) { return stored[id]; },
		async list() { return Object.entries(stored).filter(([, value]) => value).map(([providerId, value]) => ({ providerId, type: value.type })); },
		async modify() { throw new Error("Comparison uses read-only credentials"); },
		async delete() { throw new Error("Comparison uses read-only credentials"); },
	};
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	const model = runtime.getModel(spec.provider, spec.model);
	if (!model?.reasoning) throw new Error("A known reasoning model is required");
	const rows = [];
	try {
		for (const task of spec.tasks) for (const variant of variants) {
			const root = await mkdtemp(join(tmpdir(), "pi-reasoning-compare-"));
			let session;
			let calls = 0, jevCost = 0, missingCosts = 0, jevLatencyMs = 0, jevInputTokens = 0, jevOutputTokens = 0, missingTokens = 0;
			globalThis.fetch = async (input, options) => {
				const evaluator = String(input) === "https://openrouter.ai/api/alpha/decisions";
				if (evaluator) calls++;
				const started = performance.now();
				const response = await originalFetch(input, options);
				if (evaluator) {
					try {
						const value = await response.clone().json();
						jevLatencyMs += performance.now() - started;
						if (Number.isFinite(value.usage?.cost)) jevCost += value.usage.cost; else missingCosts++;
						const inputTokens = value.usage?.prompt_tokens ?? value.usage?.input_tokens, outputTokens = value.usage?.completion_tokens ?? value.usage?.output_tokens;
						if (Number.isFinite(inputTokens) && Number.isFinite(outputTokens)) { jevInputTokens += inputTokens; jevOutputTokens += outputTokens; } else missingTokens++;
					}
					catch { missingCosts++; missingTokens++; jevLatencyMs += performance.now() - started; }
				}
				return response;
			};
			try {
				const cwd = join(root, "workspace"), agentDir = join(root, "agent");
				await git(root, ["clone", "--no-hardlinks", "--no-checkout", "--", repository, cwd]);
				await git(cwd, ["checkout", "--detach", commit]);
				await git(cwd, ["remote", "remove", "origin"]);
				process.env.PI_CODING_AGENT_DIR = agentDir;
				await mkdir(agentDir, { mode: 0o700 });
				const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
				await writeFile(join(agentDir, "adaptive-reasoning.yaml"), `enabled: ${variant === "adaptive"}\nmaxLeaseSteps: 10\n`);
				const { default: adaptive } = await import("../extensions/adaptive-reasoning/index.ts");
				const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [adaptive] });
				await loader.reload();
				({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: variant === "high" ? "high" : "medium", settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd) }));
				await session.bindExtensions({ mode: "print" });
				const started = performance.now();
				await session.prompt(task.prompt);
				const elapsedMs = Math.round(performance.now() - started);
				const messages = session.messages.filter((message) => message.role === "assistant");
				const usage = messages.map((message) => message.usage);
				const agentFailed = messages.some((message) => message.stopReason === "error" || message.stopReason === "aborted");
				let verified = false;
				try { await run(task.verify.command, task.verify.args, { cwd, timeout: 120_000, maxBuffer: 1024 * 1024 }); verified = true; } catch { /* Record failure without dumping output or secrets. */ }
				rows.push({ task: task.name, variant, commit, elapsedMs, success: verified && !agentFailed,
					reasoningTokens: usage.length && usage.every((value) => typeof value?.reasoning === "number") ? usage.reduce((n, value) => n + value.reasoning, 0) : null,
					mainReportedCost: usage.reduce((n, value) => n + (value?.cost?.total ?? 0), 0), jevCalls: calls, jevReportedCost: missingCosts ? null : jevCost,
					jevLatencyMs: Math.round(jevLatencyMs), jevInputTokens: missingTokens ? null : jevInputTokens, jevOutputTokens: missingTokens ? null : jevOutputTokens });
			} finally { session?.dispose(); await rm(root, { recursive: true, force: true }); }
		}
		console.log(JSON.stringify({ ...plan, results: rows }, null, 2));
	} finally {
		globalThis.fetch = originalFetch;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
}
