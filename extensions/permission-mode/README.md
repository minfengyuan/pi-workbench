# Permission Mode

Host-process guardrails for Pi Agent tool calls. This extension reduces accidental actions; it is **not a sandbox** and cannot constrain other trusted extensions or code running in the Pi process.

## Modes

- **Read Only** — host safe-read and read-only network tools. Writes, mutating shell commands, and unknown tools are blocked.
- **Workspace Write** — host safe-read plus file writes inside the enclosing Git repository (or Pi cwd outside Git). Ambiguous shell commands, build scripts, remote mutations, and unknown tools require one-call approval.
- **Full Access** — host read/write; this extension stops blocking tool calls. Existing Pi tool selection and Gondolin sandbox restrictions remain active.

Host safe-read is not an unconditional `/` allowlist: any canonical host path is readable, known-sensitive paths are denied, and global `allowSensitivePaths` can override that deny. `grep`/`find` are checked on their path argument only, so nested sensitive files inside an allowed directory are a residual risk.

Use `/permissions` to switch modes. Full Access requires a second confirmation. Start with an explicit mode using:

```bash
pi -e /path/to/pi-workbench --permission-mode=read-only
pi -e /path/to/pi-workbench --permission-mode=workspace-write
pi -e /path/to/pi-workbench --permission-mode=full-access
```

A persisted Full Access selection is downgraded to Workspace Write after reload, resume, or process restart unless the CLI explicitly selects Full Access again. Plan mode forces Read Only. With `--sandbox=dev`, every mode remains inside the Gondolin guest.

User-entered `!` and `!!` commands are intentionally not controlled by Permission Mode. The sandbox extension still routes those commands into its VM when enabled.

## Configuration

Global policy: `~/.pi/agent/permissions.yaml`

```yaml
defaultMode: workspace-write
allowedReadRoots:
  - /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs
allowSensitivePaths:
  - /absolute/project/path/.env.example
tools:
  documentation_lookup: read
  custom_writer: workspace-write
  web_lookup: network-read
  deployment: full
```

`allowedReadRoots` is accepted for compatibility and does not constrain host reads. Use `allowSensitivePaths` to permit specific credential files.

Trusted project policy: `<git-root>/.pi/permissions.yaml`

```yaml
defaultMode: read-only
readRoots:
  - /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs
disabledTools:
  - deployment
```

Project policy can disable tools and choose a non-Full default. `readRoots` must still be a subset of the global `allowedReadRoots` list when present, but neither list gates reads. Tool names are exact; glob matching is intentionally unsupported. A custom tool classification is a global administrator's trust statement—the extension cannot infer or validate arbitrary custom schemas.

Invalid configuration fails closed to Read Only. Configuration is loaded at extension/session initialization and `/reload`; files are not watched live.

## Policy notes

- Existing paths are canonicalized. New write paths are checked through their nearest existing parent.
- Write paths that symlink or traverse out of the workspace are denied. Read paths follow the canonical target and then apply safe-read rules.
- `.env*`, `.netrc`/`.npmrc`/`.pypirc`, private key/certificate files, credential/token files, `.ssh`/`.gnupg`/`.aws`/`.azure`/`.config/gcloud`, `/etc/shadow`/`sudoers`, and sensitive Git configuration are denied outside Full Access unless globally allowed.
- Shell classification is conservative and best-effort. Package scripts and unclear commands require approval in Workspace Write and are blocked without an interactive UI.
- Approval applies to one tool call and is never remembered.
- Search and fetch tools are considered network reads. Upload, publish, and push operations are not read-only.

For hostile repositories, unattended execution, or strict containment, use `--sandbox=dev` or an external OS/container sandbox.
