import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const SENSITIVE_BASENAME = /^(?:\.env(?:\..*)?|credentials?(?:\..*)?|tokens?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i;

function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function canonicalForWrite(path: string): Promise<string> {
	let cursor = resolve(path);
	const suffix: string[] = [];
	while (true) {
		try {
			const parent = await realpath(cursor);
			return resolve(parent, ...suffix.reverse());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const next = dirname(cursor);
			if (next === cursor) throw error;
			suffix.push(basename(cursor));
			cursor = next;
		}
	}
}

async function canonicalExisting(path: string): Promise<string> {
	const canonical = await realpath(path);
	const stat = await lstat(canonical);
	if (stat.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${path}`);
	return canonical;
}

export interface FilesystemPolicy {
	workspace: string;
	readRoots: string[];
	allowSensitivePaths: string[];
}

export async function createFilesystemPolicy(
	workspace: string,
	readRoots: string[],
	allowSensitivePaths: string[],
): Promise<FilesystemPolicy> {
	return {
		workspace: await realpath(workspace),
		readRoots: await Promise.all(readRoots.map((path) => realpath(path))),
		allowSensitivePaths: await Promise.all(allowSensitivePaths.map((path) => canonicalForWrite(path))),
	};
}

function isSensitive(path: string): boolean {
	const normalized = path.split(sep);
	if (SENSITIVE_BASENAME.test(basename(path))) return true;
	const git = normalized.lastIndexOf(".git");
	return git >= 0 && ["config", "credentials"].includes(normalized[git + 1] ?? "");
}

export async function checkReadPath(policy: FilesystemPolicy, inputPath: string): Promise<string | undefined> {
	try {
		const target = await canonicalExisting(resolve(policy.workspace, inputPath || "."));
		const roots = [policy.workspace, ...policy.readRoots];
		if (!roots.some((root) => isInside(root, target))) return `read path is outside approved roots: ${inputPath}`;
		if (isSensitive(target) && !policy.allowSensitivePaths.some((root) => isInside(root, target))) {
			return `sensitive path is not globally allowed: ${inputPath}`;
		}
		return undefined;
	} catch (error) {
		return `read path cannot be validated: ${(error as Error).message}`;
	}
}

export async function checkWritePath(policy: FilesystemPolicy, inputPath: string): Promise<string | undefined> {
	try {
		const target = await canonicalForWrite(resolve(policy.workspace, inputPath));
		if (!isInside(policy.workspace, target)) return `write path escapes workspace: ${inputPath}`;
		return undefined;
	} catch (error) {
		return `write path cannot be validated: ${(error as Error).message}`;
	}
}

export function isLexicallyInsideGuestWorkspace(inputPath: string): boolean {
	const target = resolve("/workspace", inputPath || ".");
	return isInside("/workspace", target);
}
