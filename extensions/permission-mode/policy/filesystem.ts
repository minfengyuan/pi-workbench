import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const SENSITIVE_BASENAME = /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|\.pypirc|credentials?(?:\..*)?|tokens?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i;
const SENSITIVE_DIR_NAMES = new Set([".ssh", ".gnupg", ".aws", ".azure"]);
const SENSITIVE_ETC_FILES = new Set(["shadow", "master.passwd", "sudoers"]);

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
	writeRoots: string[];
	allowSensitivePaths: string[];
}

async function canonicalDirectory(path: string): Promise<string> {
	const canonical = await realpath(path);
	const stat = await lstat(canonical);
	if (!stat.isDirectory()) throw new Error(`additional directory is not a directory: ${path}`);
	if (dirname(canonical) === canonical) throw new Error(`additional directory cannot be the filesystem root: ${path}`);
	return canonical;
}

export async function createFilesystemPolicy(
	workspace: string,
	allowSensitivePaths: string[],
	additionalDirectories: string[] = [],
): Promise<FilesystemPolicy> {
	const workspaceRoot = await realpath(workspace);
	const extras = await Promise.all(additionalDirectories.map((path) => canonicalDirectory(path)));
	return {
		workspace: workspaceRoot,
		writeRoots: [...new Set([workspaceRoot, ...extras])],
		allowSensitivePaths: await Promise.all(allowSensitivePaths.map((path) => canonicalForWrite(path))),
	};
}

function isSensitive(path: string): boolean {
	const parts = path.split(sep);
	if (SENSITIVE_BASENAME.test(basename(path))) return true;
	if (parts.some((part) => SENSITIVE_DIR_NAMES.has(part))) return true;
	const git = parts.lastIndexOf(".git");
	if (git >= 0 && ["config", "credentials"].includes(parts[git + 1] ?? "")) return true;
	const config = parts.lastIndexOf(".config");
	if (config >= 0 && parts[config + 1] === "gcloud") return true;
	const etc = parts.lastIndexOf("etc");
	return etc >= 0 && SENSITIVE_ETC_FILES.has(parts[etc + 1] ?? "");
}

export async function checkReadPath(policy: FilesystemPolicy, inputPath: string): Promise<string | undefined> {
	try {
		const target = await canonicalExisting(resolve(policy.workspace, inputPath || "."));
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
		if (!policy.writeRoots.some((root) => isInside(root, target))) return `write path escapes write roots: ${inputPath}`;
		return undefined;
	} catch (error) {
		return `write path cannot be validated: ${(error as Error).message}`;
	}
}

export function isLexicallyInsideGuestWorkspace(inputPath: string): boolean {
	const target = resolve("/workspace", inputPath || ".");
	return isInside("/workspace", target);
}
