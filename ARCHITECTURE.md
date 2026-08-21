# Workbench architecture

```text
Host Pi (TUI, session, provider auth)
  ├─ permission-mode extension
  │   ├─ branch-aware mode controller
  │   ├─ tool/path/shell policy
  │   ├─ tool_call enforcement + one-call approval
  │   └─ plan/sandbox integration bridge
  ├─ plan-mode extension
  └─ sandbox extension
      ├─ config/policy + unknown-tool lockdown
      ├─ workspace manager (sanitized launch snapshot repository)
      ├─ audit JSONL
      ├─ explicit host apply command
      └─ Gondolin backend
          ├─ /workspace -> disposable snapshot repository only
          └─ /cache/* -> constrained dependency cache roots
```

## Permission layer

Permission Mode runs in the Host Pi process and gates Agent `tool_call` events. It resolves the enclosing Git root, canonicalizes file paths, classifies tools and shell commands, and either allows, blocks, or requests one-call approval. It does not intercept user `!`/`!!` commands and cannot mediate direct actions performed by another extension or Node.js code. Its Full Access mode removes only its own gate; it does not re-enable tools removed by Pi settings or another extension.

Mode changes are stored as branch-local custom session entries. Full Access is not restored from an entry after reload or resume. Plan mode asserts a Read Only override through a small shared runtime bridge. The same bridge tells Permission Mode when Gondolin is active, so guest paths are evaluated against `/workspace` and the footer reports the combined state.

## Sandbox layer

`session_start` loads global sandbox policy and, only for a trusted project, project policy. Project network/environment lists are intersected with global capabilities; deny lists are additive. The manager assembles the launch state in a temporary clone, removes denied files and the entire cloned Git object database, then initializes a fresh single-commit repository. Later export therefore contains only agent changes, not historical denied blobs or the user's pre-existing dirty state.

The sandbox extension overrides `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` using Pi's operation interfaces. File operations are confined to `/workspace`; `!` commands use the same Gondolin bash operations. Gondolin receives a filtered environment and `createHttpHooks` allowlist. Dependency caches are mounted from dedicated, non-overlapping roots that projects may disable but cannot enable beyond global policy. A credential-free HTTPS Git origin is retained for fetch, while guest commits use a sandbox-only identity. Session shutdown closes loopback ingress and the VM, then removes the workspace; startup also garbage-collects dead leased workspaces and stale Gondolin session-registry entries.

`/sandbox apply` copies the private launch baseline and disposable workspace without Git metadata into a fresh Host-controlled repository, then exports a binary patch. Host code never opens guest-controlled `.git`. It verifies the host still has the launch base commit, runs `git apply --check`, prompts the user, and only then applies the patch.

Permission Mode and sandbox controls compose monotonically: Permission Mode may further restrict guest operations, but Full Access cannot bypass sandbox tool ownership, filesystem, environment, or network policy.
