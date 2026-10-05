# Workbench architecture

```text
Host Pi (TUI, session, provider auth)
  ├─ permission-mode extension
  │   ├─ branch-aware mode controller
  │   ├─ tool/path/shell policy
  │   ├─ tool_call enforcement + one-call approval
  │   └─ plan/sandbox integration bridge
  ├─ plan-mode extension
  ├─ adaptive-reasoning extension
  │   ├─ bounded public context -> OpenRouter / TypeSafe Jev
  │   ├─ generation lease + baseline controller
  │   └─ session-only thinking selection
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

Permission Mode runs in the Host Pi process and gates Agent `tool_call` events. It resolves the enclosing Git root, canonicalizes file paths, classifies tools and shell commands, and either allows, blocks, or requests one-call approval. Read Only and Workspace Write use host safe-read (canonical host paths except known-sensitive files) and confine writes to the workspace plus `--add-dir` / `additionalDirectories`; Full Access is host read/write. Extra write roots are listed in the footer, `/permissions`, and the agent system prompt. It does not intercept user `!`/`!!` commands and cannot mediate direct actions performed by another extension or Node.js code. Its Full Access mode removes only its own gate; it does not re-enable tools removed by Pi settings or another extension.

Mode changes are stored as branch-local custom session entries. Full Access is not restored from an entry after reload or resume. Plan mode asserts a Read Only override through a small shared runtime bridge. The same bridge tells Permission Mode when Gondolin is active, so guest paths are evaluated against `/workspace` and the footer reports the combined state.

## Sandbox layer

`session_start` loads global sandbox policy and, only for a trusted project, project policy. Project network/environment lists are intersected with global capabilities; deny lists are additive. The manager assembles the launch state in a temporary clone, removes denied files and the entire cloned Git object database, then initializes a fresh single-commit repository. Later export therefore contains only agent changes, not historical denied blobs or the user's pre-existing dirty state.

The sandbox extension overrides `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` using Pi's operation interfaces. File operations are confined to `/workspace`; `!` commands use the same Gondolin bash operations. Gondolin receives a filtered environment and `createHttpHooks` allowlist. Dependency caches are mounted from dedicated, non-overlapping roots that projects may disable but cannot enable beyond global policy. A credential-free HTTPS Git origin is retained for fetch, while guest commits use a sandbox-only identity. Session shutdown closes loopback ingress and the VM, then removes the workspace; startup also garbage-collects dead leased workspaces and stale Gondolin session-registry entries.

`/sandbox apply` copies the private launch baseline and disposable workspace without Git metadata into a fresh Host-controlled repository, then exports a binary patch. Host code never opens guest-controlled `.git`. It verifies the host still has the launch base commit, runs `git apply --check`, prompts the user, and only then applies the patch.

Permission Mode and sandbox controls compose monotonically: Permission Mode may further restrict guest operations, but Full Access cannot bypass sandbox tool ownership, filesystem, environment, or network policy.

## Adaptive reasoning

Adaptive Reasoning runs independently in Host Pi. It changes only the main model's thinking level, using `before_agent_start` for the first generation and awaited `turn_end` for later generations before Pi refreshes the loop settings. A Jev decision covers 1, 2, 5, or 10 generations, including the next generation; parallel tool calls consume one generation. Tool failures and context/model changes invalidate the lease. Asynchronous decisions are revision-bound and cannot apply after cancellation or a state change.

The controller keeps the user's baseline separate from temporary effort choices. Manual effort changes pause automation for the task. Evaluator failures return to baseline and pause retries until the next task. Fully settled tasks and disabling the extension restore baseline. Versioned custom session entries preserve branch-local enabled/baseline state, while leases and pending requests are never resumed.

The context builder includes user text, public assistant text, and at most six recent tool previews. Each tool result is bounded to 1,000 local tokens using head/tail truncation; the serialized evaluator request is limited to 28,000 local tokens and 2,100,000 bytes. Typed effort choices come from the current Pi model's supported levels. Only OpenRouter's Decisions API with the pinned `typesafe/jev-1.13` model and TypeSafe provider is used. Global configuration and explicit CLI/session commands can enable evaluation; project configuration cannot.
