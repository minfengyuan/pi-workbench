import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceSnapshot } from "../types.ts";

const execFileAsync = promisify(execFile);
const SAFE_CONFIG_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

function safeGitEnv(home: string): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		LANG: "C",
		LC_ALL: "C",
		HOME: home,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
	};
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", [...SAFE_CONFIG_ARGS, ...args], {
		cwd,
		encoding: "utf8",
		maxBuffer: 100 * 1024 * 1024,
		env: safeGitEnv(tmpdir()),
	});
	return result.stdout;
}

async function copyWithoutGitMetadata(source: string, destination: string): Promise<void> {
	await cp(source, destination, {
		recursive: true,
		preserveTimestamps: true,
		filter: (entry) => !relative(source, entry).split(sep).includes(".git"),
	});
}

async function clearWorktree(repository: string): Promise<void> {
	for (const entry of await readdir(repository)) {
		if (entry !== ".git") await rm(join(repository, entry), { recursive: true, force: true });
	}
}

/**
 * Export through a fresh Host-controlled repository. Guest .git metadata is
 * never copied or opened; global/system config, hooks, fsmonitor, external diff,
 * and textconv are disabled. The fresh index also honors project .gitignore, so
 * dependency installs and other ignored build output are not exported.
 */
export async function exportPatch(snapshot: WorkspaceSnapshot): Promise<Buffer> {
	const directory = await mkdtemp(join(tmpdir(), "pi-sandbox-export-"));
	const repository = join(directory, "repo");
	try {
		await mkdir(repository);
		await git(repository, ["init", "-q"]);
		await copyWithoutGitMetadata(snapshot.baselinePath, repository);
		await git(repository, ["add", "-A"]);
		await git(repository, [
			"-c", "user.name=Pi Sandbox",
			"-c", "user.email=pi-sandbox@invalid",
			"commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "sandbox baseline",
		]);
		await clearWorktree(repository);
		await copyWithoutGitMetadata(snapshot.path, repository);
		await git(repository, ["add", "-A"]);
		const result = await execFileAsync(
			"git",
			[...SAFE_CONFIG_ARGS, "diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"],
			{ cwd: repository, encoding: "buffer", maxBuffer: 100 * 1024 * 1024, env: safeGitEnv(directory) },
		);
		return result.stdout;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export async function verifyApply(snapshot: WorkspaceSnapshot, patch: Buffer): Promise<void> {
	const current = (await git(snapshot.hostSource, ["rev-parse", "HEAD"])).trim();
	if (current !== snapshot.baseCommit) {
		throw new Error(`Host HEAD changed since sandbox start (${snapshot.baseCommit.slice(0, 12)} -> ${current.slice(0, 12)})`);
	}
	if (patch.length === 0) return;
	const directory = await mkdtemp(join(tmpdir(), "pi-sandbox-apply-"));
	const patchPath = join(directory, "changes.patch");
	try {
		await writeFile(patchPath, patch, { mode: 0o600 });
		await git(snapshot.hostSource, ["apply", "--check", "--", patchPath]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export async function applyPatch(snapshot: WorkspaceSnapshot, patch: Buffer): Promise<void> {
	await verifyApply(snapshot, patch);
	if (patch.length === 0) return;
	const directory = await mkdtemp(join(tmpdir(), "pi-sandbox-apply-"));
	const patchPath = join(directory, "changes.patch");
	try {
		await writeFile(patchPath, patch, { mode: 0o600 });
		await git(snapshot.hostSource, ["apply", "--", patchPath]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
