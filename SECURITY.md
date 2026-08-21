# Security boundaries

`extensions/permission-mode` is an in-process guardrail against accidental Agent actions. It is not a sandbox: Pi extensions execute with host user privileges, and Permission Mode cannot constrain another extension's `pi.exec` calls, Node.js APIs, direct process execution, or malicious tool implementation. Its Shell and custom-tool classifications are trusted policy hints rather than OS enforcement. User `!`/`!!` commands intentionally bypass Permission Mode.

Permission configuration fails closed, project policy cannot broaden global read roots or tool trust, Full Access requires explicit elevation, and a persisted Full Access mode is downgraded on reload/resume. These controls reduce mistakes but do not establish an adversarial security boundary.

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

## Not yet implemented

Dynamic network grants, automatic dev-server detection, secret brokers, cloud credentials, and alternate backends are outside this MVP. The real-VM integration gate covers core env/socket, commit, push-deny, disposable-workspace, and teardown invariants; broader filesystem, process-exhaustion, and network redirect matrices remain required before marking the sandbox stable.
