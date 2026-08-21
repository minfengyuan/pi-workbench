import { lstat, mkdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { CacheConfig } from "../types.ts";

export const CACHE_GUEST_PATHS = {
	npm: "/cache/npm",
	pnpm: "/cache/pnpm",
	pip: "/cache/pip",
	cargo: "/cache/cargo",
	go: "/cache/go",
} as const;

export type CacheName = keyof typeof CACHE_GUEST_PATHS;

function isInside(root: string, target: string): boolean {
	return target === root || target.startsWith(`${root}${sep}`);
}

function pathsOverlap(left: string, right: string): boolean {
	return isInside(left, right) || isInside(right, left);
}

export async function prepareCacheDirectories(
	cacheRoot: string,
	config: CacheConfig,
	hostSource: string,
): Promise<Record<string, string>> {
	const absoluteRoot = resolve(cacheRoot);
	const absoluteHost = await realpath(hostSource);
	if (pathsOverlap(absoluteHost, absoluteRoot)) throw new Error("Sandbox cache root must not overlap the host repository");

	await mkdir(absoluteRoot, { recursive: true, mode: 0o700 });
	const canonicalRoot = await realpath(absoluteRoot);
	if (pathsOverlap(absoluteHost, canonicalRoot)) throw new Error("Sandbox cache root must not overlap the host repository");
	const rootStat = await lstat(absoluteRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Unsafe sandbox cache root: ${absoluteRoot}`);
	const mounts: Record<string, string> = {};
	for (const name of Object.keys(CACHE_GUEST_PATHS) as CacheName[]) {
		if (!config[name]) continue;
		const directory = join(canonicalRoot, name);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const stat = await lstat(directory);
		const canonical = await realpath(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink() || !isInside(canonicalRoot, canonical)) {
			throw new Error(`Unsafe sandbox cache directory: ${directory}`);
		}
		mounts[CACHE_GUEST_PATHS[name]] = canonical;
	}
	return mounts;
}

export function buildCacheEnv(config: CacheConfig): Record<string, string> {
	const env: Record<string, string> = {};
	if (config.npm) env.NPM_CONFIG_CACHE = CACHE_GUEST_PATHS.npm;
	if (config.pnpm) env.PNPM_HOME = CACHE_GUEST_PATHS.pnpm;
	if (config.pip) env.PIP_CACHE_DIR = CACHE_GUEST_PATHS.pip;
	if (config.cargo) env.CARGO_HOME = CACHE_GUEST_PATHS.cargo;
	if (config.go) {
		env.GOCACHE = `${CACHE_GUEST_PATHS.go}/build`;
		env.GOMODCACHE = `${CACHE_GUEST_PATHS.go}/pkg/mod`;
	}
	return env;
}
