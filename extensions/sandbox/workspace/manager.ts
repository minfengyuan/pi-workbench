import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isDeniedSnapshotPath } from "../policy/filesystem.ts";
import type { WorkspaceSnapshot } from "../types.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[], encoding: BufferEncoding | "buffer" = "utf8"): Promise<string | Buffer> {
	const result = await execFileAsync("git", args, {
		cwd,
		encoding: encoding === "buffer" ? "buffer" : encoding,
		maxBuffer: 100 * 1024 * 1024,
		env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
	});
	return result.stdout;
}

function assertInside(root: string, target: string): void {
	const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
	if (target !== root && !target.startsWith(prefix)) throw new Error(`Snapshot path escapes repository: ${target}`);
}

export async function findGitRoot(cwd: string): Promise<string> {
	return realpath((await git(cwd, ["rev-parse", "--show-toplevel"]) as string).trim());
}

async function canonicalPath(value: string): Promise<string> {
	const absolute = resolve(value);
	try {
		return await realpath(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(absolute);
		if (parent === absolute) return absolute;
		return join(await canonicalPath(parent), absolute.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
	}
}

export async function createWorkspace(
	cwd: string,
	workspaceRoot: string,
	denyReadPatterns: readonly string[] = [],
): Promise<WorkspaceSnapshot> {
	const hostSource = await findGitRoot(cwd);
	const resolvedWorkspaceRoot = await canonicalPath(workspaceRoot);
	if (resolvedWorkspaceRoot === hostSource || resolvedWorkspaceRoot.startsWith(`${hostSource}${sep}`)) {
		throw new Error("Sandbox workspace root must be outside the host repository");
	}
	const baseCommit = (await git(hostSource, ["rev-parse", "HEAD"]) as string).trim();
	await mkdir(resolvedWorkspaceRoot, { recursive: true, mode: 0o700 });
	const sessionPath = await mkdtemp(join(resolvedWorkspaceRoot, "session-"));
	const workspacePath = join(sessionPath, "repo");
	const baselinePath = join(sessionPath, "baseline");

	try {
		await git(hostSource, ["clone", "--no-hardlinks", "--no-checkout", "--", hostSource, workspacePath]);
		await git(workspacePath, ["checkout", "--detach", baseCommit]);

		const patch = await git(hostSource, ["diff", "--binary", "HEAD"], "buffer") as Buffer;
		if (patch.length > 0) {
			const patchPath = join(workspacePath, ".git", "pi-snapshot.patch");
			await writeFile(patchPath, patch, { mode: 0o600 });
			try {
				await git(workspacePath, ["apply", "--whitespace=nowarn", "--", patchPath]);
			} finally {
				await rm(patchPath, { force: true });
			}
		}

		const trackedRaw = await git(workspacePath, ["ls-files", "-z"], "buffer") as Buffer;
		for (const relativePath of trackedRaw.toString("utf8").split("\0").filter(Boolean)) {
			if (isDeniedSnapshotPath(relativePath, denyReadPatterns)) {
				await rm(resolve(workspacePath, relativePath), { force: true, recursive: true });
			}
		}

		const untrackedRaw = await git(hostSource, ["ls-files", "--others", "--exclude-standard", "-z"], "buffer") as Buffer;
		const untracked = untrackedRaw.toString("utf8").split("\0").filter(Boolean);
		let copied = 0;
		for (const relativePath of untracked) {
			if (isDeniedSnapshotPath(relativePath, denyReadPatterns)) continue;
			const source = resolve(hostSource, relativePath);
			const destination = resolve(workspacePath, relativePath);
			assertInside(hostSource, source);
			assertInside(workspacePath, destination);
			const stat = await lstat(source);
			if (stat.isSymbolicLink() || !stat.isFile()) continue;
			await mkdir(dirname(destination), { recursive: true });
			await cp(source, destination, { preserveTimestamps: true });
			copied++;
		}

		const changedRaw = await git(hostSource, ["diff", "--name-only", "HEAD", "-z"], "buffer") as Buffer;
		const changed = changedRaw.toString("utf8").split("\0").filter(Boolean).length;
		await git(workspacePath, ["add", "-A"]);
		await git(workspacePath, [
			"-c", "user.name=Pi Sandbox",
			"-c", "user.email=pi-sandbox@invalid",
			"commit", "--allow-empty", "--no-gpg-sign", "-m", "pi sandbox launch snapshot",
		]);
		const snapshotCommit = (await git(workspacePath, ["rev-parse", "HEAD"]) as string).trim();
		await cp(workspacePath, baselinePath, {
			recursive: true,
			preserveTimestamps: true,
			filter: (source) => source !== join(workspacePath, ".git") && !source.startsWith(`${join(workspacePath, ".git")}${sep}`),
		});
		return {
			hostSource,
			path: workspacePath,
			baselinePath,
			baseCommit,
			snapshotCommit,
			dirty: patch.length > 0 || copied > 0,
			files: changed + copied,
			createdAt: Date.now(),
		};
	} catch (error) {
		await rm(sessionPath, { recursive: true, force: true });
		throw error;
	}
}

export async function destroyWorkspace(snapshot: WorkspaceSnapshot): Promise<void> {
	await rm(dirname(snapshot.path), { recursive: true, force: true });
}

export async function readWorkspaceFile(snapshot: WorkspaceSnapshot, relativePath: string): Promise<Buffer> {
	const target = resolve(snapshot.path, relativePath);
	assertInside(snapshot.path, target);
	return readFile(target);
}
