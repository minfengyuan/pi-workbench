# Sandbox extension

Run with `pi -e . --sandbox=dev` from a Git repository. The extension starts a sanitized, single-commit disposable snapshot repository in a Gondolin micro-VM and routes Pi's built-in file/command tools plus `!` commands into it.

Commands: `/sandbox status|tools|processes|serve <guest-port>|diff|apply|destroy`.

Dependency caches for npm, pnpm, pip, Cargo, and Go persist under `~/.cache/pi-sandbox/cache`; projects may disable, but cannot enable, caches beyond global policy. `/sandbox serve` exposes one guest HTTP port on an ephemeral `127.0.0.1` host port.

This MVP does not implement dynamic network grants, automatic dev-server detection, secret brokers, or alternate backends. See the repository `SECURITY.md`.
