// Compare the production HTTP Jev client with the benchmark-only native classify() adapter.
// Default: offline plan, no credentials or network. --live sends billable evaluator requests.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir, ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { buildEvaluatorState } from "../extensions/adaptive-reasoning/context.ts";
import { JEV_MODEL, JevClient } from "../extensions/adaptive-reasoning/jev.ts";
import { NATIVE_JEV, nativeDecide } from "../extensions/adaptive-reasoning/native.ts";

class UsageError extends Error {}
const PATHS = ["http", "native"];
const ENDPOINTS = { http: "https://openrouter.ai/api/alpha/decisions", native: "https://openrouter.ai/api/v1/systemone" };
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const args = process.argv.slice(2);
function parseArgs() {
	const [casesPath, ...rest] = args;
	let live = false, repeat = 1;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--live") live = true;
		else if (rest[i] === "--repeat" && /^[1-9]\d?$/.test(rest[i + 1] ?? "")) repeat = Number(rest[++i]);
		else throw new UsageError("invalid arguments");
	}
	return { casesPath: resolve(casesPath), live, repeat };
}
const DEFAULT_STATE = { model: "benchmark/model", supportedEfforts: ["none", "low", "medium", "high"], latestUserPrompt: "", step: 0, previousEffort: "medium", newToolFailures: 0 };
/** A case gives either raw Pi messages (built through the real context budgets) or a ready state. */
function caseState(entry) {
	const metadata = { ...DEFAULT_STATE, ...(entry.metadata ?? {}) };
	if (Array.isArray(entry.messages)) return buildEvaluatorState(entry.messages, metadata);
	return { ...buildEvaluatorState([], metadata), ...(entry.state ?? {}) };
}
function validateSpec(spec) {
	const maxLeaseSteps = spec.maxLeaseSteps ?? 10;
	if (![1, 2, 5, 10].includes(maxLeaseSteps) || !Array.isArray(spec.cases) || !spec.cases.length) throw new UsageError("invalid cases file");
	for (const entry of spec.cases) {
		if (typeof entry?.name !== "string" || !entry.name) throw new UsageError("every case needs a name");
		const state = caseState(entry);
		if (!state.supportedEfforts.length || state.supportedEfforts.some((e) => !EFFORTS.includes(e))) throw new UsageError(`case ${entry.name} has unsupported efforts`);
		for (const key of ["effort", "lease"]) if (entry.expect?.[key] !== undefined && (!Array.isArray(entry.expect[key]) || entry.expect[key].some((v) => typeof v !== "string"))) throw new UsageError(`case ${entry.name} expect.${key} must be a string array`);
	}
	return maxLeaseSteps;
}
/** Wrap fetch to time attempts and read the raw body (usage, served-by) without printing it. */
function observedFetch(base) {
	const seen = { attempts: 0, statuses: [], body: undefined };
	const fetchImpl = async (input, init) => {
		seen.attempts++;
		const response = await base(input, init);
		seen.statuses.push(response.status);
		if (response.ok) { try { seen.body = await response.clone().json(); } catch { seen.body = undefined; } }
		return response;
	};
	return { seen, fetchImpl };
}
function errorCategory(error, statuses) {
	const result = error?.result;
	if (result?.stopReason === "aborted" || error?.name === "AbortError" || error?.name === "TimeoutError") return "aborted";
	if (/budget/.test(error?.message ?? "")) return "local-budget";
	if (/invalid (model|effort)|did not return|invalid (probabilities|confidence)|unexpected response/.test(error?.message ?? "")) return "invalid-answer";
	const status = statuses.at(-1);
	return status && status >= 400 ? `http-${status}` : "network";
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
function usageOf(path, body, result) {
	const raw = body?.usage ?? {};
	return {
		inputTokens: num(result?.usage?.input) ?? num(raw.input_tokens) ?? num(raw.prompt_tokens),
		outputTokens: num(result?.usage?.output) ?? num(raw.output_tokens) ?? num(raw.completion_tokens),
		cachedTokens: num(raw.cached_tokens) ?? num(raw.prompt_tokens_details?.cached_tokens) ?? num(raw.input_tokens_details?.cached_tokens),
		reportedCost: num(raw.cost),
		catalogCost: path === "native" ? num(result?.usage?.cost?.total) : null,
	};
}
async function runOne(path, ctx, state, maxLeaseSteps) {
	const { seen, fetchImpl } = observedFetch(globalThis.fetch);
	const started = performance.now();
	let decision, error, result, structure = null;
	try {
		if (path === "http") decision = await new JevClient(fetchImpl).decide(state, ctx.apiKey, maxLeaseSteps);
		else ({ decision, result } = await nativeDecide(ctx.runtime, state, maxLeaseSteps, { fetch: fetchImpl }));
	} catch (caught) { error = caught; result = caught?.result; }
	const latencyMs = Math.round(performance.now() - started);
	const answers = seen.body?.answers;
	if (answers && typeof answers === "object") structure = { choiceAnswers: ["effort", "lease"].every((k) => answers[k]?.type === "choice"), probabilities: ["effort", "lease"].every((k) => answers[k]?.probabilities && typeof answers[k].probabilities === "object"), confidence: ["effort", "lease"].every((k) => num(answers[k]?.confidence) !== null) };
	return {
		ok: !error, error: error ? errorCategory(error, seen.statuses) : null, latencyMs, attempts: seen.attempts,
		effort: decision ? (decision.level === "off" ? "none" : decision.level) : null, lease: decision ? String(decision.leaseSteps) : null,
		servedBy: { provider: typeof seen.body?.provider === "string" ? seen.body.provider : null, model: typeof seen.body?.model === "string" ? seen.body.model : null },
		structure, usage: usageOf(path, seen.body, result),
	};
}
const percentile = (values, p) => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const total = (rows, key) => rows.every((r) => r.usage[key] !== null) ? rows.reduce((n, r) => n + r.usage[key], 0) : null;
function summarize(rows) {
	const summary = {};
	for (const path of PATHS) {
		const mine = rows.filter((r) => r.path === path), ok = mine.filter((r) => r.ok);
		const scored = (key) => mine.filter((r) => r.match[key] !== null);
		const accuracy = (key) => scored(key).length ? scored(key).filter((r) => r.match[key]).length / scored(key).length : null;
		const latencies = mine.map((r) => r.latencyMs);
		summary[path] = {
			requests: mine.length, ok: ok.length, validRate: mine.length ? ok.length / mine.length : null,
			errors: Object.fromEntries([...new Set(mine.filter((r) => r.error).map((r) => r.error))].map((e) => [e, mine.filter((r) => r.error === e).length])),
			effortAccuracy: accuracy("effort"), leaseAccuracy: accuracy("lease"),
			latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), mean: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null },
			servedByTypeSafe: mine.filter((r) => r.servedBy.provider === "TypeSafe").length,
			usage: { inputTokens: total(ok, "inputTokens"), outputTokens: total(ok, "outputTokens"), cachedTokens: total(ok, "cachedTokens"), reportedCost: total(mine, "reportedCost"), catalogCost: path === "native" ? total(mine, "catalogCost") : null },
		};
	}
	const pairs = new Map();
	for (const r of rows) { const key = `${r.case}\0${r.repeat}`; pairs.set(key, { ...pairs.get(key), [r.path]: r }); }
	const both = [...pairs.values()].filter((p) => p.http?.ok && p.native?.ok);
	summary.agreement = { comparable: both.length, sameEffort: both.filter((p) => p.http.effort === p.native.effort).length, sameLease: both.filter((p) => p.http.lease === p.native.lease).length };
	return summary;
}
async function main() {
	const { casesPath, live, repeat } = parseArgs();
	const spec = JSON.parse(await readFile(casesPath, "utf8"));
	const maxLeaseSteps = validateSpec(spec);
	const plan = { live, repeat, maxLeaseSteps, paths: PATHS, endpoints: ENDPOINTS, models: { http: JEV_MODEL, native: `${NATIVE_JEV.provider}/${NATIVE_JEV.id}` }, cases: spec.cases.map((c) => c.name), requests: spec.cases.length * PATHS.length * repeat };
	if (!live) { console.log(JSON.stringify(plan, null, 2)); return; }

	const stored = readStoredCredential("openrouter", join(getAgentDir(), "auth.json"));
	const credentials = {
		async read(id) { return id === "openrouter" ? stored : undefined; },
		async list() { return stored ? [{ providerId: "openrouter", type: stored.type }] : []; },
		async modify() { throw new Error("Benchmark uses read-only credentials"); },
		async delete() { throw new Error("Benchmark uses read-only credentials"); },
	};
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	const apiKey = (await runtime.getAuth("openrouter"))?.auth.apiKey;
	if (!apiKey) throw new UsageError("no OpenRouter credential (stored or OPENROUTER_API_KEY)");
	const rows = [];
	for (let r = 0; r < repeat; r++) for (const [index, entry] of spec.cases.entries()) {
		const state = caseState(entry);
		// Alternate path order so warm connections do not always favor one path.
		for (const path of (index + r) % 2 ? [...PATHS].reverse() : PATHS) {
			const row = await runOne(path, { apiKey, runtime }, state, maxLeaseSteps);
			const match = { effort: entry.expect?.effort ? (row.ok ? entry.expect.effort.includes(row.effort) : false) : null, lease: entry.expect?.lease ? (row.ok ? entry.expect.lease.includes(row.lease) : false) : null };
			rows.push({ case: entry.name, path, repeat: r, ...row, match });
		}
	}
	console.log(JSON.stringify({ ...plan, summary: summarize(rows), results: rows }, null, 2));
}

if (!args.length || args.includes("--help")) {
	console.log("Usage: npm run benchmark:jev -- cases.json [--live] [--repeat N]\nDefault: offline plan. --live sends billable Jev requests through both paths with the stored OpenRouter credential.");
} else {
	try { await main(); }
	catch (error) { console.error(`Jev benchmark failed: ${error instanceof UsageError ? error.message : "check cases, credentials and network"}. Provider responses and credentials are not printed.`); process.exitCode = 1; }
}
