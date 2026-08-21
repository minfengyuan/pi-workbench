# Pi Workbench

Pi Agent extensions packaged using the Pi Package structure.

## Extensions

- [`extensions/plan-mode`](./extensions/plan-mode/) — read-only exploration mode with plan extraction and progress tracking.
- [`extensions/sandbox`](./extensions/sandbox/) — Gondolin-backed disposable development sandbox.

## Development sandbox

Requirements: Node.js 23.6+ and Gondolin's supported virtualization backend (QEMU, or a supported krun runner).

```bash
npm install --ignore-scripts
cd /path/to/git/repository
pi -e /path/to/pi-workbench --sandbox=dev
```

The host Pi process keeps the TUI, session, and provider credentials. File tools, bash, and `!` commands run in a Gondolin micro-VM against a sanitized single-commit snapshot repository. Use `/sandbox status`, `/sandbox tools`, `/sandbox files`, `/sandbox network`, `/sandbox processes`, `/sandbox serve <guest-port>`, `/sandbox reset`, `/sandbox diff`, `/sandbox apply`, or `/sandbox destroy`.

Global configuration is read from `~/.pi/agent/sandbox.yaml`. Trusted projects may add `.pi/sandbox.yaml`, but project network/environment lists can only narrow global capabilities. See [SECURITY.md](./SECURITY.md) before use.

Use `--sandbox=off` to explicitly disable the sandbox extension behavior.

## Try plan mode locally

```bash
pi -e . --plan
```

## Validation

```bash
npm test
npm run test:integration  # requires QEMU or a supported Gondolin runner
npm run typecheck
```
