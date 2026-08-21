import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RealFSProvider, type VM } from "@earendil-works/gondolin";
import { AuditLogger } from "../extensions/sandbox/audit/logger.ts";
import { GondolinBackend } from "../extensions/sandbox/backend/gondolin.ts";
import { prepareCacheDirectories } from "../extensions/sandbox/cache/manager.ts";
import { createGondolinReadOps } from "../extensions/sandbox/tools/gondolin-operations.ts";
import type { SandboxConfig, WorkspaceSnapshot } from "../extensions/sandbox/types.ts";

test("audit logs rotate old daily files", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-sandbox-audit-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "2000-01-01.jsonl"), "old\n");
	await new AuditLogger(root, 30).write({ session: "test", event: "sandbox.started" });
	await assert.rejects(realpath(join(root, "2000-01-01.jsonl")));
});

test("cache directories reject canonical and symlink escapes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-sandbox-cache-policy-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const host = join(root, "host");
	const safe = join(root, "safe-cache");
	const linked = join(root, "linked-cache");
	await mkdir(host);
	await symlink(host, linked);
	const enabled = { npm: true, pnpm: false, pip: false, cargo: false, go: false };
	const mounts = await prepareCacheDirectories(safe, enabled, host);
	const canonicalSafe = await realpath(safe);
	assert.deepEqual(mounts, { "/cache/npm": join(canonicalSafe, "npm") });
	await assert.rejects(prepareCacheDirectories(join(host, "cache"), enabled, host), /must not overlap/);
	await assert.rejects(prepareCacheDirectories(root, enabled, host), /must not overlap/);
	await assert.rejects(prepareCacheDirectories(linked, enabled, host), /must not overlap|Unsafe/);

	const outside = join(root, "outside.txt");
	const nestedLink = join(safe, "npm", "escape");
	await writeFile(outside, "host secret");
	await symlink(outside, nestedLink);
	const provider = new RealFSProvider(join(safe, "npm"));
	await assert.rejects(provider.open("/escape", "r"));
	await assert.rejects(provider.open("/escape", "w"));
});

test("file operations reject paths outside the guest workspace", async () => {
	let readPath = "";
	const vm = {
		fs: {
			readFile: async (path: string) => { readPath = path; return Buffer.from("ok"); },
		},
	} as unknown as VM;
	const operations = createGondolinReadOps(vm, "/host/repo");
	await operations.readFile("/host/repo/src/index.ts");
	assert.equal(readPath, "/workspace/src/index.ts");
	await assert.rejects(operations.readFile("../../etc/passwd"), /outside \/workspace/);
	await assert.rejects(operations.readFile("/etc/passwd"), /outside \/workspace/);
});

test("concurrent ingress startup is single-flight and teardown closes a late listener", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-sandbox-ingress-"));
	const host = join(root, "host");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(host), mkdir(workspace)]);
	t.after(() => rm(root, { recursive: true, force: true }));
	const config: SandboxConfig = {
		mode: "dev", workspaceRoot: join(root, "workspaces"), cacheRoot: join(root, "cache"),
		network: { allow: [] }, environment: { allow: [] }, filesystem: { denyRead: [] },
		cache: { npm: false, pnpm: false, pip: false, cargo: false, go: false },
	};
	const snapshot: WorkspaceSnapshot = {
		hostSource: host, path: workspace, baselinePath: join(root, "baseline"), baseCommit: "base",
		snapshotCommit: "snapshot", remoteUrl: "https://github.com/org/repo.git", dirty: false, files: 0, createdAt: Date.now(),
	};
	let releaseIngress!: (value: { host: string; port: number; url: string; close(): Promise<void> }) => void;
	let ingressStarted!: () => void;
	const started = new Promise<void>((resolve) => { ingressStarted = resolve; });
	let ingressCreates = 0;
	let ingressCloses = 0;
	let vmCloses = 0;
	const commands: string[][] = [];
	const fakeVm = {
		id: "vm",
		exec: (command: string[]) => {
			commands.push(command);
			return Promise.resolve({ exitCode: 0, stdout: command.includes("bash") ? "/bin/bash\n" : "", stderr: "" });
		},
		setIngressRoutes: () => {},
		enableIngress: () => {
			ingressCreates++;
			ingressStarted();
			return new Promise((resolve) => { releaseIngress = resolve; });
		},
		close: async () => { vmCloses++; },
	} as unknown as VM;
	const backend = new GondolinBackend(config, snapshot, new AuditLogger(join(root, "logs")), "test", (async () => fakeVm) as typeof VM.create);
	await backend.start();
	assert.equal(commands.some((command) => command.join(" ").includes("user.name Pi Sandbox")), true);
	assert.equal(commands.some((command) => command.join(" ").includes("user.email pi-sandbox@invalid")), true);
	assert.equal(commands.some((command) => command.join(" ").includes("commit.gpgSign false")), true);
	assert.equal(commands.some((command) => command.join(" ").includes("remote add origin https://github.com/org/repo.git")), true);
	const first = assert.rejects(backend.serve(3000), /destroyed during ingress startup/);
	await started;
	await assert.rejects(backend.serve(4000), /already forwards guest port 3000/);
	const destroy = backend.destroy();
	releaseIngress({ host: "127.0.0.1", port: 43127, url: "http://127.0.0.1:43127", close: async () => { ingressCloses++; } });
	await Promise.all([first, destroy]);
	assert.equal(ingressCreates, 1);
	assert.equal(ingressCloses, 1);
	assert.equal(vmCloses, 1);
});

test("destroy waits for in-flight VM startup and closes the late VM", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-sandbox-backend-"));
	const host = join(root, "host");
	const workspace = join(root, "workspace");
	const cache = join(root, "cache");
	const logs = join(root, "logs");
	await Promise.all([mkdir(host), mkdir(workspace)]);
	t.after(() => rm(root, { recursive: true, force: true }));

	const config: SandboxConfig = {
		mode: "dev",
		workspaceRoot: join(root, "workspaces"),
		cacheRoot: cache,
		network: { allow: [] },
		environment: { allow: [] },
		filesystem: { denyRead: [] },
		cache: { npm: false, pnpm: false, pip: false, cargo: false, go: false },
	};
	const snapshot: WorkspaceSnapshot = {
		hostSource: host,
		path: workspace,
		baselinePath: join(root, "baseline"),
		baseCommit: "base",
		snapshotCommit: "snapshot",
		dirty: false,
		files: 0,
		createdAt: Date.now(),
	};

	let release!: (vm: VM) => void;
	let factoryStarted!: () => void;
	const started = new Promise<void>((resolve) => { factoryStarted = resolve; });
	let closes = 0;
	const fakeVm = {
		id: "late-vm",
		close: async () => { closes++; },
		exec: () => { throw new Error("provisioning must not run after destroy"); },
	} as unknown as VM;
	const factory = (() => {
		factoryStarted();
		return new Promise<VM>((resolve) => { release = resolve; });
	}) as typeof VM.create;
	const backend = new GondolinBackend(config, snapshot, new AuditLogger(logs), "test", factory);

	const start = backend.start();
	const startRejection = assert.rejects(start, /destroyed during startup/);
	await started;
	const destroy = backend.destroy();
	release(fakeVm);
	await destroy;
	await startRejection;
	assert.equal(closes, 1);
	await assert.rejects(backend.start(), /has been destroyed/);
});
