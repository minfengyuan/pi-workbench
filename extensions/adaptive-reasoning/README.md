# Adaptive Reasoning

An independent, opt-in extension that chooses the main model's thinking level at generation boundaries. This package targets Pi 1.1.0. Permission Mode, Plan Mode and Sandbox do not control its decisions or network access.

## Enable

Use Pi's global agent directory (normally `~/.pi/agent`):

```yaml
# adaptive-reasoning.yaml
enabled: false
maxLeaseSteps: 10
```

`maxLeaseSteps` accepts `1`, `2`, `5` or `10`. Project configuration cannot enable this extension. Invalid global configuration disables it. `PI_CODING_AGENT_DIR` follows Pi's standard global directory override.

```bash
pi -e . --adaptive-reasoning=on
```

The flag overrides the global enable default. `/adaptive-reasoning on|off|status` changes only the session; the command without arguments offers a menu in interactive mode and status otherwise. Enable state and the user's baseline are saved on the session branch. Leases are not persisted. Missing OpenRouter credentials disable evaluation; normal Pi continues. Configure OpenRouter through Pi's credential management before enabling again.

## Decisions and manual control

The evaluator is OpenRouter `typesafe/jev-1.13`, restricted to TypeSafe with provider fallback disabled. Two typed Choice questions select a supported effort and a lease of 1, 2, 5 or 10 generations. `off` maps to `none`. Choices always follow the main model's capabilities; nonreasoning models never call Jev.

The first decision runs in `before_agent_start`; subsequent decisions run in awaited `turn_end` handlers before the next generation snapshot. A generation with several parallel calls consumes one lease step. Input, failures, model selection, compaction and tree navigation cancel leases. Queued input restores baseline until the real user message reaches awaited `message_end`, which evaluates it before the next request snapshot. The ordinary initial user message is not evaluated twice.

Changing thinking manually (or from another extension) updates baseline and pauses automatic decisions for the current task. The next task resumes evaluation. Jev failures discard the lease and return to baseline for the current task; the next task retries. Disabling, settled tasks, session restoration and normal exit also restore baseline. On model selection, Pi’s selected thinking level (including scoped or per-model settings and capability clamping) becomes the new baseline. Automatic model-switch thinking events do not count as manual overrides. Dynamic calls never persist Pi's global thinking default.

HTTP 429/5xx receive at most three attempts inside a 30 second deadline. Other failures, invalid answers, local context limits and cancellation do not switch providers. In-flight decisions are revision checked, so stale results cannot override new user state.

Footer examples: `reason:AUTO·H·2`, `reason:MANUAL`, `reason:JEV!`, `reason:OFF`. A notification appears only when a new decision changes the actual thinking level.

## External data boundary

Enabling sends user goals, assistant **public text**, recent tool names/argument previews/result previews and model/effort metadata to OpenRouter/TypeSafe. Only the six most recent tool calls are projected; each argument and result preview is capped at 1,000 local `o200k_base` tokens with head/tail preservation. The entire serialized evaluator request must stay below 28,000 local tokens and 2,100,000 bytes, or it is rejected locally.

Thinking blocks, images/binary content, raw provider payloads, credential objects, environment variables and request headers are not projected. The extension does not read extra files for the evaluator. This is a structural filter, **not secret detection**: secrets included in user text, public assistant text, tool arguments or tool output can still be transmitted. Treat enablement as consent to this external transfer. No original evaluator body or credentials are logged by this extension.

Sandbox isolates tool execution. It does **not** prevent this Host Pi extension from sending evaluator context over the network. Repository instructions and tool results are untrusted evidence for the evaluator and cannot authorize enabling it.

No cost reduction is guaranteed. Compare task acceptance, main model reasoning tokens, Jev requests/cost and total latency on fixed workloads before drawing conclusions.
