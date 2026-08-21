import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { AuditLogger } from "../../extensions/sandbox/audit/logger.ts";
import { GondolinBackend } from "../../extensions/sandbox/backend/gondolin.ts";
import type { SandboxConfig } from "../../extensions/sandbox/types.ts";
import { createWorkspace, destroyWorkspace } from "../../extensions/sandbox/workspace/manager.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout;
}

test("real Gondolin VM enforces the development sandbox boundary", { timeout: 180_000 }, async (t) => {
	const host = await mkdtemp(join(tmpdir(), "pi-sandbox-integration-host-"));
	const runtime = await mkdtemp(join(tmpdir(), "pi-sandbox-integration-runtime-"));
	t.after(() => rm(host, { recursive: true, force: true }));
	t.after(() => rm(runtime, { recursive: true, force: true }));

	await git(host, "init", "-q");
	await writeFile(join(host, "tracked.txt"), "host\n");
	await git(host, "add", "tracked.txt");
	await git(host, "-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-qm", "base");
	await git(host, "remote", "add", "origin", "https://example.com/org/repo.git");

	const config: SandboxConfig = {
		mode: "dev",
		workspaceRoot: join(runtime, "workspaces"),
		cacheRoot: join(runtime, "cache"),
		network: { allow: ["dl-cdn.alpinelinux.org"] },
		environment: { allow: ["PI_SANDBOX_TEST_SECRET"] },
		filesystem: { denyRead: [] },
		cache: { npm: false, pnpm: false, pip: false, cargo: false, go: false },
	};
	const snapshot = await createWorkspace(host, config.workspaceRoot);
	t.after(() => destroyWorkspace(snapshot));

	const previousSecret = process.env.PI_SANDBOX_TEST_SECRET;
	process.env.PI_SANDBOX_TEST_SECRET = "must-not-enter-guest";
	const backend = new GondolinBackend(config, snapshot, new AuditLogger(join(runtime, "logs")), "integration");
	t.after(() => backend.destroy());
	try {
		const vm = await backend.start();
		const boundary = await vm.exec(["/bin/sh", "-lc", [
			'test "$HOME" = /root',
			'test -z "${PI_SANDBOX_TEST_SECRET:-}"',
			'test -z "${SSH_AUTH_SOCK:-}"',
			'test ! -e /var/run/docker.sock',
			'test ! -e /root/.ssh/id_rsa',
		].join(" && ")]);
		assert.equal(boundary.exitCode, 0, boundary.stderr);

		const commit = await vm.exec(["/bin/sh", "-lc", "printf 'agent\\n' >> /workspace/tracked.txt && git -C /workspace add tracked.txt && git -C /workspace commit -m 'agent commit'"]);
		assert.equal(commit.exitCode, 0, commit.stderr);

		const push = await vm.exec(["/bin/sh", "-lc", "timeout 20 git -C /workspace push origin HEAD:refs/heads/pi-sandbox-test"]);
		assert.notEqual(push.exitCode, 0, "git push unexpectedly succeeded");

		const removeWorkspace = await vm.exec(["/bin/sh", "-lc", "find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +"]);
		assert.equal(removeWorkspace.exitCode, 0, removeWorkspace.stderr);
		assert.equal(await readFile(join(host, "tracked.txt"), "utf8"), "host\n");
	} finally {
		if (previousSecret === undefined) delete process.env.PI_SANDBOX_TEST_SECRET;
		else process.env.PI_SANDBOX_TEST_SECRET = previousSecret;
		await backend.destroy();
	}
	assert.equal(backend.instance, undefined);
});
