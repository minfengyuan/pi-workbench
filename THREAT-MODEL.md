# Threat model

## Protected assets

- the user's real checkout and Git metadata;
- host files and credentials;
- host environment secrets and agent sockets;
- external systems reachable with host credentials.

## Adversaries

The model, repository content, dependencies, build scripts, and unknown third-party tools are untrusted. Expected attacks include destructive commands, path traversal, symlink escape, secret discovery/exfiltration, remote mutation, and custom-tool bypass.

## Controls

Permission Mode intercepts Agent tool calls before execution, applies branch-aware Read Only/Workspace Write/Full Access policy, canonicalizes Host file paths, denies sensitive files by default, and requires one-call approval for ambiguous or high-risk operations. It is intended to prevent accidental actions, not to contain malicious extensions or arbitrary code. Direct user shell commands are outside this control.

A launch-time snapshot is created in a standalone `git clone --no-hardlinks`. Tracked binary changes and safe non-ignored untracked files are included; `.env`, key material, `.pi`, symlinks, and ignored files are excluded. Only that clone is mounted into a Gondolin micro-VM. Tool classification and interception fail closed. Network and environment access are allowlisted. Host apply is an explicit user command with conflict checks.

## Residual risk

Permission Mode shares the Host Pi process with every loaded extension. Another extension, a custom tool implementation, or code invoked through an approved shell command can bypass its policy. Regex-based Shell classification cannot prove filesystem confinement, read-only network tools can transmit user-provided query data, and global custom-tool classifications are explicit trust decisions. Strict handling of untrusted code requires Gondolin or an external sandbox.

Gondolin and this host extension are trusted computing base. The disposable clone and audit log are host-side files controlled by the extension. Domain allowlisting does not make allowed services trustworthy. A user can intentionally place credentials into sandbox files or commands. Process resource limits, cache isolation, dynamic grants, and orphan VM garbage collection are not part of this MVP.
