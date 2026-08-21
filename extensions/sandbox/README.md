# Sandbox extension

Run with `pi -e . --sandbox=dev` from a Git repository. The extension starts a disposable clone in a Gondolin micro-VM and routes Pi's built-in file/command tools plus `!` commands into it.

Commands: `/sandbox status|tools|diff|apply|destroy`.

This MVP does not implement dynamic network grants, cache mounts, dev-server forwarding, secret brokers, or alternate backends. See the repository `SECURITY.md`.
