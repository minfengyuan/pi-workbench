# Permission Mode

Host-process guardrails for Pi Agent tool calls. This extension reduces accidental actions; it is **not a sandbox** and cannot constrain other trusted extensions or code running in the Pi process.

## Modes

- **Read Only** — reads approved non-sensitive paths and permits read-only network tools. Writes, mutating shell commands, and unknown tools are blocked.
- **Workspace Write** — additionally permits file writes inside the enclosing Git repository (or Pi cwd outside Git). Ambiguous shell commands, build scripts, remote mutations, and unknown tools require one-call approval.
- **Full Access** — this extension stops blocking tool calls. Existing Pi tool selection and Gondolin sandbox restrictions remain active.

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

Trusted project policy: `<git-root>/.pi/permissions.yaml`

```yaml
defaultMode: read-only
readRoots:
  - /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs
disabledTools:
  - deployment
```

Project policy can only select roots already allowed globally, disable tools, and choose a non-Full default. Tool names are exact; glob matching is intentionally unsupported. A custom tool classification is a global administrator's trust statement—the extension cannot infer or validate arbitrary custom schemas.

Invalid configuration fails closed to Read Only. Configuration is loaded at extension/session initialization and `/reload`; files are not watched live.

## Policy notes

- Existing paths are canonicalized. New write paths are checked through their nearest existing parent.
- Symlink and traversal escapes are denied.
- `.env*`, private key/certificate files, credential/token files, and sensitive Git configuration are denied outside Full Access unless globally allowed.
- Shell classification is conservative and best-effort. Package scripts and unclear commands require approval in Workspace Write and are blocked without an interactive UI.
- Approval applies to one tool call and is never remembered.
- Search and fetch tools are considered network reads. Upload, publish, and push operations are not read-only.

For hostile repositories, unattended execution, or strict containment, use `--sandbox=dev` or an external OS/container sandbox.
