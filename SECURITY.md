# Security boundaries

`extensions/permission-mode` is an in-process guardrail against accidental Agent actions. It is not a sandbox: Pi extensions execute with host user privileges, and Permission Mode cannot constrain another extension's `pi.exec` calls, Node.js APIs, direct process execution, or malicious tool implementation. Its Shell and custom-tool classifications are trusted policy hints rather than OS enforcement. User `!`/`!!` commands intentionally bypass Permission Mode.

Permission configuration fails closed, project policy cannot broaden global tool trust, Full Access requires explicit elevation, and a persisted Full Access mode is downgraded on reload/resume. Outside Full Access, host reads use safe-read (`/` readable, known-sensitive paths denied, `allowSensitivePaths` may override) and writes stay inside the workspace plus any `additionalDirectories` / `--add-dir` roots. These controls reduce mistakes but do not establish an adversarial security boundary.

`extensions/sandbox` is the security boundary for `--sandbox=dev`.

The host Pi process retains provider authentication, sessions, and UI. Agent file and command tools are overridden and executed by `GondolinBackend` against a sanitized, single-commit disposable snapshot repository mounted at `/workspace`. The source clone metadata is removed before guest startup, so denied historical blobs are not exposed. The real checkout, host home, credential files, environment, SSH agent, and Docker socket are not mounted.

Security invariants:

- startup or policy errors disable all model tools; there is no host fallback;
- unknown model tools are removed from the active set and blocked again at `tool_call`;
- guest environment is allowlisted, with a second sensitive-name deny layer;
- outbound HTTPS on port 443 is restricted by Gondolin host patterns; internal IP ranges are denied and methods are read-only except Git fetch's `git-upload-pack` POST;
- push, package publish, and other HTTP mutations are denied independently of command spelling;
- Host snapshot/export Git operations disable system/global config, hooks, external diff, and textconv; export never opens Agent-controlled `.git` metadata;
- only credential-free HTTPS Git remotes are copied into the guest; Host Git identity, credentials, SSH config, and signing settings are not forwarded;
- persistent dependency caches use dedicated non-overlapping roots, reject canonical/symlinked roots, and are never executed by Host code;
- optional dev-server ingress binds only to an ephemeral `127.0.0.1` port and is closed before VM teardown;
- audit URLs omit userinfo, query strings, and fragments, and daily logs older than 30 days are removed;
- applying changes to the host is only available through `/sandbox apply`, after base verification, `git apply --check`, and user confirmation.

The extension itself runs with host privileges and must be installed only from a trusted source. `--sandbox=off` intentionally provides no isolation.

## Adaptive evaluator data boundary

Adaptive Reasoning is disabled by default and may be enabled through global configuration, an explicit CLI flag, or a session command. Project configuration cannot enable it. When enabled, Host Pi sends token-budgeted user goals and history, budgeted public assistant text (newest first, taken from Pi's model-visible session projection, so compacted-away or context-edited content is excluded), recent tool call previews/results, and model/effort metadata to OpenRouter's TypeSafe Jev evaluator. Pi resolves the OpenRouter credential; no second credential file is introduced.

The projection excludes private thinking, image/binary blocks, provider payloads and headers, environment objects, and credential objects. It does not read extra files to gather evaluator context or write raw evaluator requests to logs. These structural exclusions are not secret detection: a user prompt, tool argument, file excerpt, or tool result may already contain a secret and be sent as public text. Enable only when this transfer is acceptable for the task and repository.

Gondolin's guest network policy does not govern this Host extension's HTTP requests. `--sandbox=dev` therefore does not prevent tool output from being sent to Jev. The evaluator cannot authorize tools, expand permission modes, or change sandbox policy. Its recommendations select only a supported thinking level and a bounded generation lease. Invalid or failed recommendations restore the user's baseline without stopping the main agent; this is a performance preference, not a correctness or security gate.

## Not yet implemented

Dynamic network grants, automatic dev-server detection, secret brokers, cloud credentials, and alternate backends are outside this MVP. The real-VM integration gate covers core env/socket, commit, push-deny, disposable-workspace, and teardown invariants; broader filesystem, process-exhaustion, and network redirect matrices remain required before marking the sandbox stable.
