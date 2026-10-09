# Pi Workbench

Pi Agent extensions packaged using the Pi Package structure.

## Extensions

- [`extensions/permission-mode`](./extensions/permission-mode/) — Agent tool guardrails with Read Only, Workspace Write, and Full Access modes.
- [`extensions/plan-mode`](./extensions/plan-mode/) — read-only exploration mode with plan extraction and progress tracking.
- [`extensions/sandbox`](./extensions/sandbox/) — Gondolin-backed disposable development sandbox.
- [`extensions/adaptive-reasoning`](./extensions/adaptive-reasoning/) — opt-in Jev decisions for the next generation's thinking level, with baseline fallback.

## Adaptive reasoning

Requires Pi 1.0.2+ within the 1.x series and an OpenRouter credential configured in Pi.

```bash
pi -e . --adaptive-reasoning=on
```

Use `/adaptive-reasoning on`, `off`, or `status`. The extension is disabled by default. It sends bounded user goals, public assistant text, and recent tool output to OpenRouter's TypeSafe Jev evaluator. Private thinking and provider credential objects are excluded; public text and tool output can still contain sensitive information. Sandbox mode does not restrict this Host extension's evaluator requests. See the extension README and [SECURITY.md](./SECURITY.md) before enabling.

Manual thinking changes apply for the rest of the current task. Evaluator failure restores the user's baseline and waits until the next task before trying again. Adaptive reasoning changes session settings without changing the global thinking default.

To inspect the comparison workload without network calls:

```bash
npm run compare:adaptive -- scripts/adaptive-workload.example.json
```

Copy the example, set a known Pi provider/model, and point `repository` to a committed workload baseline. All three variants use the same HEAD commit in separate disposable local clones; dirty changes and untracked files are excluded. The live runner disables unrelated extensions, context files, skills, retries, and automatic compaction for comparison. It uses built-in host tools, so use a trusted workload. It does not provide sandbox isolation. Configure any workload dependencies identically in each task prompt.

Adding `--live` explicitly runs billable main-model and evaluator requests, then the workload's verification command. Credentials are read from Pi without writing its auth file; OAuth requiring refresh and custom model definitions are unsupported by this small comparison runner. Results report verification success, reasoning tokens (null when unreported), Jev request count/cost/latency/input and output tokens, main-model reported cost, and task latency excluding verification. A failed or missing Jev credential may make Adaptive fall back; inspect the call count. The example is a smoke workload, not evidence of savings. Repeat representative workloads before drawing cost or quality conclusions.

To compare the production HTTP Jev client with Pi's native `classify()` path on the same evaluator inputs:

```bash
npm run benchmark:jev -- scripts/jev-cases.example.json            # offline plan
npm run benchmark:jev -- my-cases.json --live --repeat 3           # billable
```

Each case gives a ready evaluator `state` or raw Pi `messages` (built through the real context budgets), plus optional expected `effort`/`lease` sets. The report covers, per path: valid-answer rate, error categories, effort/lease accuracy, p50/p95/mean latency, how many answers were served by TypeSafe, answer structure, token usage, OpenRouter-reported cost, Pi catalog cost (native only), and cross-path agreement. The native path is benchmark-only; [docs/adaptive-reasoning-native-jev.md](./docs/adaptive-reasoning-native-jev.md) explains why the extension still uses the HTTP client.

## Permission modes

```bash
pi -e . --permission-mode=workspace-write
```

Use `/permissions` to select Read Only, Workspace Write, or Full Access. `--add-dir` and `additionalDirectories` expand workspace-write roots and are listed in the status line and `/permissions`. Global policy is read from `~/.pi/agent/permissions.yaml`; trusted projects may narrow it with `.pi/permissions.yaml`. Plan mode forces Read Only, and sandbox mode keeps all three permission levels inside the Gondolin guest.

Permission Mode is an in-process guardrail, not a security sandbox. See [`extensions/permission-mode/README.md`](./extensions/permission-mode/README.md) and [SECURITY.md](./SECURITY.md).

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
