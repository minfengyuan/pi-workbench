# Adaptive Reasoning: hand-written Jev client vs native `classify()`

Phase 3 compares the extension's hand-written OpenRouter client (`extensions/adaptive-reasoning/jev.ts`) with Pi's native classifier path, `ctx.modelRegistry.classify()`, as shipped in the locked Pi **1.1.0** packages. Every statement about the native path comes from the installed `dist` files listed at the end. No live request was made: there was no OpenRouter credential in the environment, so wire behavior that only the server can confirm is marked **unverified**.

## Paths compared

| | Hand-written client | Native `ctx.modelRegistry.classify()` |
| --- | --- | --- |
| Model | literal `typesafe/jev-1.13` | catalog entry `getModelOfType("classifier", "openrouter", "typesafe/jev-1.13")`, API `typesafe-system-one`, `contextWindow` 32,000, cost input $0.042/M |
| Endpoint | `POST https://openrouter.ai/api/alpha/decisions` | `POST https://openrouter.ai/api/v1/systemone` (TypeSafe System One protocol served by OpenRouter) |
| Body | `{ model, provider, state, questions }` | `{ model, state, questions }` (`bool` questions become wire `noul`; this extension only uses `choice`) |
| Credential | `ctx.modelRegistry.getApiKeyForProvider("openrouter")`, then `Authorization: Bearer` | runtime resolves `openrouter` auth itself (stored key, `OPENROUTER_API_KEY` or OpenRouter OAuth) |

## Findings

| Item | Hand-written | Native | Equivalent? |
| --- | --- | --- | --- |
| Provider pinning | Sends `provider: { only: ["typesafe"], allow_fallbacks: false }` | Sends no provider-routing field. `onPayload` can add the same object, but whether `/api/v1/systemone` honors OpenRouter provider routing is **unverified** | **No** (can be added; server behavior unverified) |
| Served-by verification | Rejects any response unless `provider === "TypeSafe"` and `model` matches `typesafe/jev-1.13(-YYYYMMDD)?` | `ClassifierResult.provider`/`.model` are copied from the *requested* catalog model (`"openrouter"`, `"typesafe/jev-1.13"`). The response body's provider/model are discarded, so the upstream that served the request can't be checked. Only an `options.fetch` wrapper that clones the response could recover them | **No** |
| Answer structure | Reads `answers.effort/lease.{type, choice}`, then checks the effort is a supported level and the lease is an allowed value ≤ `maxLeaseSteps` | Same `answers.<id>` object shape. Additionally requires numeric `probabilities` (object) and `confidence`, so it is stricter, and a response without them is an error. Returns `ClassifierChoiceAnswer { choice, probabilities, confidence }`. Range checks (supported effort, lease ≤ max) still need extension code | Yes for `choice`, with stricter parsing; extension validation is still required |
| Usage: prompt/completion | Ignored | `usage.input_tokens`/`output_tokens` mapped to `Usage.input`/`output`/`totalTokens` | Native is better |
| Usage: cached tokens | Ignored | `cacheRead`/`cacheWrite` always `0` (not parsed) | Neither |
| Usage: cost | Ignored (the benchmark reads `usage.cost` from the raw body) | Computed from catalog price (`calculateCost`). OpenRouter's reported `usage.cost` is ignored. Usage is kept even when answer parsing fails (billed requests) | Different source of truth |
| Errors | Throws. HTTP 429/5xx retried, other statuses fail. Network errors are not retried | Never throws. Returns `stopReason: "error" \| "aborted"` with `errorMessage`. Retries 408/409/429/5xx **and** status-less (network/timeout) errors. Honors `x-should-retry` | No (adapter needed; retry set differs) |
| Retries/backoff | 3 attempts, 250 ms × 2ⁿ | `maxRetries` default 2 (3 attempts), 0.5 s × 2ⁿ with jitter, honors `retry-after(-ms)` up to `maxRetryDelayMs` (60 s default) | Close; must cap with `maxRetries`/`maxRetryDelayMs` |
| Timeouts | One 30 s deadline for all attempts (plus the extension's own 30 s deadline) | `timeoutMs` is **per attempt**. An overall deadline needs the caller's `signal` | Equivalent only if the caller passes an overall-deadline signal |
| Abort | `AbortSignal.any([signal, deadline])` checked before and after each step, including JSON read and backoff | `signal` passed to fetch and retry sleep; aborted → `stopReason: "aborted"` | Yes |
| Headers | Only `authorization`, `content-type` | `authorization`, `content-type`, model headers, provider-auth headers and `options.headers`. Pi's attribution headers and `before_provider_headers` hooks are **not** applied (`ModelRegistry.classify` calls the runtime directly) | Mostly; more header sources |
| Redirects | `redirect: "error"` (bearer token never follows a redirect) | Default fetch redirect (`follow`). Closable only through an `options.fetch` wrapper | **No** |
| Local size budget | `serializeRequest` rejects > 28,000 tokens / 2,100,000 bytes before sending | No local budget (the catalog `contextWindow` is not enforced client-side) | Extension must keep its own check |

## Decision: do not migrate now

Migration is blocked by the security-relevant guarantees, not by convenience features:

1. **Provider pinning can't be shown equivalent.** The native endpoint is different (`/api/v1/systemone` vs `/api/alpha/decisions`). `onPayload` could add the same `provider` object, but nothing in the installed packages shows that this endpoint applies OpenRouter provider routing.
2. **Served-by verification is lost.** The native result reports the requested model, not the upstream provider. Today the extension refuses any answer not served by TypeSafe.
3. **Redirect protection is lost** unless a custom `fetch` is injected.

Closing 2 and 3 means wrapping `options.fetch` to force `redirect: "error"` and parse the raw body again. That re-implements most of the hand-written client while still depending on unverified server behavior for (1). The hand-written client therefore stays the production path.

What the native path does better is usage accounting (token counts and catalog cost, kept even for malformed answers). Phase 3 adds a benchmark-only native adapter (`extensions/adaptive-reasoning/native.ts`) that:

- builds the identical `state`/`questions` from `decisionRequest()`;
- keeps the local request budget;
- adds the same `provider` pinning object through `onPayload` (best effort, unverified);
- runs with `maxRetries: 2`, `timeoutMs: 30_000` and the caller's deadline signal;
- applies the same effort/lease validation.

It is **not wired into the extension**.

### Revisit when

- A live `--live` benchmark run shows that `/api/v1/systemone` honors `provider.only`/`allow_fallbacks` and returns the serving provider. Check with an `onResponse`-visible header or a body field Pi could expose.
- Pi exposes the upstream provider/model or a redirect policy on `ClassifierResult`/`ClassifierOptions`.
- Agreement, structure-validity and latency from `npm run benchmark:jev -- cases.json --live` are no worse than the hand-written path.

## Sources (installed Pi 1.1.0)

- `@earendil-works/pi-coding-agent/dist/core/model-registry.{d.ts,js}`: `classify`, `getModelOfType`, delegation to the runtime.
- `@earendil-works/pi-coding-agent/dist/core/model-runtime.js`: `classify`, `prepareRequest` (auth, headers, `transformHeaders`).
- `@earendil-works/pi-ai/dist/providers/openrouter.js`, `providers/data/openrouter.json`: `typesafe-system-one` classifier, `typesafe/jev-1.13` catalog entry.
- `@earendil-works/pi-ai/dist/api/typesafe-system-one.js`, `api/system-one-shared.js`: endpoint, payload, answer parsing, error result.
- `@earendil-works/pi-ai/dist/api/classifier-shared.js`: request, per-attempt timeout, `onPayload`/`onResponse`, usage parsing.
- `@earendil-works/pi-ai/dist/utils/provider-retry.js`: retryable statuses and backoff.
- `@earendil-works/pi-ai/dist/types.d.ts`: `ClassifierContext`, `ClassifierResult`, `ClassifierOptions`, `ProviderRequestOptions`.
