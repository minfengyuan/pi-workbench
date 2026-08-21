import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { applyPatch, exportPatch, verifyApply } from "../extensions/sandbox/workspace/export.ts";
import { createWorkspace, destroyWorkspace } from "../extensions/sandbox/workspace/manager.ts";

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout;
}

async function repository(): Promise<{ root: string; cache: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-sandbox-repo-"));
	const cache = await mkdtemp(join(tmpdir(), "pi-sandbox-cache-"));
	await git(root, "init", "-q");
	await writeFile(join(root, ".gitignore"), ".env\nnode_modules/\n");
	await writeFile(join(root, "tracked.txt"), "base\n");
	await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
	await writeFile(join(root, "tracked.pem"), "tracked secret\n");
	await git(root, "add", ".");
	await git(root, "-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-qm", "base");
	return { root, cache };
}

test("workspace root inside the host repository is rejected", async (t) => {
	const { root, cache } = await repository();
	t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(cache, { recursive: true, force: true }); });
	await assert.rejects(createWorkspace(root, join(root, ".sandbox-cache")), /must be outside/);
});

test("workspace clone captures launch state without ignored or denied secrets", async (t) => {
	const { root, cache } = await repository();
	t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(cache, { recursive: true, force: true }); });
	await writeFile(join(root, "tracked.txt"), "staged\n");
	await git(root, "add", "tracked.txt");
	await writeFile(join(root, "tracked.txt"), "staged and unstaged\n");
	await writeFile(join(root, "binary.bin"), Buffer.from([0, 255, 2, 3]));
	await writeFile(join(root, "safe.txt"), "safe\n");
	await writeFile(join(root, ".env"), "ignored secret\n");
	await writeFile(join(root, ".env.local"), "denied secret\n");
	await mkdir(join(root, ".pi"));
	await writeFile(join(root, ".pi", "evil.ts"), "secret\n");

	const snapshot = await createWorkspace(root, cache);
	t.after(() => destroyWorkspace(snapshot));
	assert.equal(await readFile(join(snapshot.path, "tracked.txt"), "utf8"), "staged and unstaged\n");
	assert.deepEqual(await readFile(join(snapshot.path, "binary.bin")), Buffer.from([0, 255, 2, 3]));
	assert.equal(await readFile(join(snapshot.path, "safe.txt"), "utf8"), "safe\n");
	await assert.rejects(readFile(join(snapshot.path, ".env")));
	await assert.rejects(readFile(join(snapshot.path, ".env.local")));
	await assert.rejects(readFile(join(snapshot.path, "tracked.pem")));
	await assert.rejects(readFile(join(snapshot.path, ".pi", "evil.ts")));
	assert.equal((await git(snapshot.path, "status", "--porcelain")).trim(), "");
	assert.equal(snapshot.dirty, true);
});

test("apply exports only agent delta and refuses a changed host HEAD", async (t) => {
	const { root, cache } = await repository();
	t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(cache, { recursive: true, force: true }); });
	await writeFile(join(root, "tracked.txt"), "launch dirty\n");
	const snapshot = await createWorkspace(root, cache);
	t.after(() => destroyWorkspace(snapshot));
	await writeFile(join(snapshot.path, "tracked.txt"), "agent edit\n");
	await writeFile(join(snapshot.path, "new.txt"), "new\n");
	await mkdir(join(snapshot.path, "node_modules", "ignored-package"), { recursive: true });
	await writeFile(join(snapshot.path, "node_modules", "ignored-package", "index.js"), "ignored\n");
	const marker = join(cache, "host-command-ran");
	await writeFile(join(snapshot.path, ".gitattributes"), "*.txt filter=escape\n");
	await git(snapshot.path, "config", "filter.escape.clean", `touch ${marker}`);
	const patch = await exportPatch(snapshot);
	assert.match(patch.toString("utf8"), /agent edit/);
	assert.doesNotMatch(patch.toString("utf8"), /ignored-package/);
	await assert.rejects(access(marker));
	await verifyApply(snapshot, patch);
	await applyPatch(snapshot, patch);
	assert.equal(await readFile(join(root, "tracked.txt"), "utf8"), "agent edit\n");
	assert.equal(await readFile(join(root, "new.txt"), "utf8"), "new\n");

	await git(root, "add", ".");
	await git(root, "-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "-qm", "host moved");
	await assert.rejects(verifyApply(snapshot, patch), /Host HEAD changed/);
});
