import { basename, posix } from "node:path";

const DENIED_BASENAMES = new Set([".env", "credentials", "id_rsa", "id_ed25519"]);
const DENIED_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"];

export function isDeniedSnapshotPath(relativePath: string, patterns: readonly string[] = []): boolean {
	const normalized = relativePath.replaceAll("\\", "/");
	const policyMatch = patterns.some((pattern) => {
		const normalizedPattern = pattern.replaceAll("\\", "/");
		return posix.matchesGlob(normalized, normalizedPattern) ||
			(normalizedPattern.startsWith("**/") && posix.matchesGlob(normalized, normalizedPattern.slice(3)));
	});
	const parts = normalized.split("/");
	const name = basename(normalized).toLowerCase();
	return (
		policyMatch ||
		normalized.startsWith("/") ||
		parts.includes("..") ||
		parts.includes(".pi") ||
		parts.includes(".git") ||
		DENIED_BASENAMES.has(name) ||
		name.startsWith(".env.") ||
		DENIED_EXTENSIONS.some((extension) => name.endsWith(extension))
	);
}
