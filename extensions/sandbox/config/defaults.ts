import { homedir } from "node:os";
import { join } from "node:path";
import type { SandboxConfig } from "../types.ts";

export const DEFAULT_CONFIG: SandboxConfig = {
	mode: "dev",
	workspaceRoot: join(homedir(), ".cache", "pi-sandbox", "workspaces"),
	cacheRoot: join(homedir(), ".cache", "pi-sandbox", "cache"),
	network: {
		allow: [
			"registry.npmjs.org",
			"*.npmjs.org",
			"registry.npmmirror.com",
			"pypi.org",
			"files.pythonhosted.org",
			"github.com",
			"api.github.com",
			"raw.githubusercontent.com",
			"crates.io",
			"static.crates.io",
			"proxy.golang.org",
			"sum.golang.org",
			"dl-cdn.alpinelinux.org",
		],
	},
	environment: { allow: ["LANG", "LC_ALL", "TERM", "CI", "NODE_ENV"] },
	filesystem: { denyRead: ["**/.env", "**/.env.*", "**/*.pem", "**/*.key"] },
	cache: { npm: true, pnpm: true, pip: true, cargo: true, go: true },
};
