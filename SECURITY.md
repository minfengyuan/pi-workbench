# Sandbox security boundary

`extensions/sandbox` is the security boundary for `--sandbox=dev`.

The host Pi process retains provider authentication, sessions, and UI. Agent file and command tools are overridden and executed by `GondolinBackend` against a standalone disposable clone mounted at `/workspace`. The real checkout, host home, credential files, environment, SSH agent, and Docker socket are not mounted.

Security invariants:

- startup or policy errors disable all model tools; there is no host fallback;
- unknown model tools are removed from the active set and blocked again at `tool_call`;
- guest environment is allowlisted, with a second sensitive-name deny layer;
- outbound HTTPS on port 443 is restricted by Gondolin host patterns; internal IP ranges are denied and methods are read-only except Git fetch's `git-upload-pack` POST;
- push, package publish, and other HTTP mutations are denied independently of command spelling;
- Host patch export never opens Agent-controlled `.git` metadata; it compares a private baseline and a metadata-free workspace copy with Git `--no-index`, with system/global config and external diff drivers disabled;
- applying changes to the host is only available through `/sandbox apply`, after base verification, `git apply --check`, and user confirmation.

The extension itself runs with host privileges and must be installed only from a trusted source. `--sandbox=off` intentionally provides no isolation.

## Not yet implemented

Dynamic network grants, caches, dev-server port forwarding, secret brokers, cloud credentials, alternate backends, and crash-orphan GC are outside this MVP.
