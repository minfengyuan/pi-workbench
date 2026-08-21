# Sandbox architecture

```text
Host Pi (TUI, session, provider auth)
  └─ sandbox extension
      ├─ config/policy + unknown-tool lockdown
      ├─ workspace manager (sanitized launch snapshot repository)
      ├─ audit JSONL
      ├─ explicit host apply command
      └─ Gondolin backend
          ├─ /workspace -> disposable snapshot repository only
          └─ /cache/* -> constrained dependency cache roots
```

`session_start` loads global policy and, only for a trusted project, project policy. Project network/environment lists are intersected with global capabilities; deny lists are additive. The manager assembles the launch state in a temporary clone, removes denied files and the entire cloned Git object database, then initializes a fresh single-commit repository. Later export therefore contains only agent changes, not historical denied blobs or the user's pre-existing dirty state.

The extension overrides `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` using Pi's operation interfaces. File operations are confined to `/workspace`; `!` commands use the same Gondolin bash operations. Gondolin receives a filtered environment and `createHttpHooks` allowlist. Dependency caches are mounted from dedicated, non-overlapping roots that projects may disable but cannot enable beyond global policy. A credential-free HTTPS Git origin is retained for fetch, while guest commits use a sandbox-only identity. Session shutdown closes loopback ingress and the VM, then removes the workspace; startup also garbage-collects dead leased workspaces and stale Gondolin session-registry entries.

`/sandbox apply` copies the private launch baseline and disposable workspace without Git metadata into a fresh Host-controlled repository, then exports a binary patch. Host code never opens guest-controlled `.git`. It verifies the host still has the launch base commit, runs `git apply --check`, prompts the user, and only then applies the patch.
