/**
 * Benchmark-only adapter for Pi's native classifier path. It is intentionally
 * not wired into the extension: see docs/adaptive-reasoning-native-jev.md for
 * the provider-pinning, served-by and redirect gaps that block migration.
 */
import type { ClassifierContext, ClassifierModel, ClassifierApi, ClassifierResult, ModelsClassifierOptions } from "@earendil-works/pi-ai";
import type { Decision } from "./controller.ts";
import { serializeRequest, type EvaluatorState } from "./context.ts";
import { decisionRequest, validateAnswers } from "./jev.ts";

export const NATIVE_JEV = { type: "classifier", provider: "openrouter", id: "typesafe/jev-1.13" } as const;
/** Same routing object the HTTP client sends. Whether /api/v1/systemone honors it is unverified. */
export const PROVIDER_PINNING = { only: ["typesafe"], allow_fallbacks: false } as const;

/** Structural subset shared by ModelRuntime and ctx.modelRegistry. */
export interface NativeClassifierRuntime {
	getModelOfType(type: "classifier", provider: string, modelId: string): ClassifierModel<ClassifierApi> | undefined;
	classify(model: ClassifierModel<ClassifierApi>, context: ClassifierContext, options?: ModelsClassifierOptions): Promise<ClassifierResult>;
}
export interface NativeDecideOptions { signal?: AbortSignal; fetch?: typeof fetch; pinProvider?: boolean; timeoutMs?: number }
export interface NativeDecision { decision: Decision; result: ClassifierResult }

/** The identical state/questions the HTTP client sends, minus its OpenRouter routing envelope. */
export function nativeClassifierContext(state: EvaluatorState, maxLeaseSteps: number): ClassifierContext {
	const request = decisionRequest(state, maxLeaseSteps) as { state: unknown; questions: ClassifierContext["questions"] };
	return { state: request.state as ClassifierContext["state"], questions: request.questions };
}
export class NativeJevError extends Error {
	readonly result?: ClassifierResult;
	constructor(message: string, result?: ClassifierResult) { super(message); this.name = "NativeJevError"; this.result = result; }
}
export async function nativeDecide(runtime: NativeClassifierRuntime, state: EvaluatorState, maxLeaseSteps: number, options: NativeDecideOptions = {}): Promise<NativeDecision> {
	const model = runtime.getModelOfType(NATIVE_JEV.type, NATIVE_JEV.provider, NATIVE_JEV.id);
	if (!model) throw new NativeJevError(`Pi catalog has no ${NATIVE_JEV.provider}/${NATIVE_JEV.id} classifier`);
	// Keep the HTTP client's local budget: the native path has none of its own.
	serializeRequest(decisionRequest(state, maxLeaseSteps));
	const deadline = AbortSignal.timeout(options.timeoutMs ?? 30_000);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
	const result = await runtime.classify(model, nativeClassifierContext(state, maxLeaseSteps), {
		signal, maxRetries: 2, maxRetryDelayMs: 5_000, timeoutMs: options.timeoutMs ?? 30_000,
		...(options.fetch ? { fetch: options.fetch } : {}),
		...(options.pinProvider === false ? {} : { onPayload: (payload: unknown) => ({ ...(payload as object), provider: PROVIDER_PINNING }) }),
	});
	if (result.stopReason !== "stop") throw new NativeJevError(result.errorMessage ?? `Native classify ${result.stopReason}`, result);
	try { return { decision: validateAnswers(result.answers, state.supportedEfforts, maxLeaseSteps), result }; }
	catch (error) { throw new NativeJevError((error as Error).message, result); }
}
