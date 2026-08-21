# Sandbox architecture

```text
Host Pi (TUI, session, provider auth)
  └─ sandbox extension
      ├─ config/policy + unknown-tool lockdown
      ├─ workspace manager (standalone launch snapshot clone)
      ├─ audit JSONL
      ├─ explicit host apply command
      └─ Gondolin backend
          └─ /workspace -> disposable clone only
```

`session_start` loads global policy and, only for a trusted project, project policy. Project network/environment lists are intersected with global capabilities; deny lists are additive. It creates a snapshot commit in the disposable clone so later export contains only agent changes, not the user's pre-existing dirty state.

The extension overrides `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` using Pi's operation interfaces. `!` commands use the same Gondolin bash operations. Gondolin receives a filtered environment and `createHttpHooks` allowlist. Session shutdown closes the VM and removes the clone.

`/sandbox apply` compares a private launch baseline with a metadata-free copy of the disposable workspace using `git diff --no-index --binary`; Host code never opens guest-controlled `.git`. It then verifies the host still has the launch base commit, runs `git apply --check`, prompts the user, and only then applies the patch.
