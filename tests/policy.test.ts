import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../extensions/sandbox/config/defaults.ts";
import { mergeConfig } from "../extensions/sandbox/config/loader.ts";
import { buildGuestEnv, isSensitiveEnvironmentName } from "../extensions/sandbox/policy/environment.ts";
import { isDeniedSnapshotPath } from "../extensions/sandbox/policy/filesystem.ts";
import { classifyTool, filterActiveTools } from "../extensions/sandbox/policy/tools.ts";
import { formatNetworkAuditResource, isAllowedNetworkRequest } from "../extensions/sandbox/policy/network.ts";
import { buildCacheEnv } from "../extensions/sandbox/cache/manager.ts";

test("guest environment is allowlisted with a sensitive-name deny layer", () => {
	const env = buildGuestEnv({ LANG: "en_US.UTF-8", CI: "1", GITHUB_TOKEN: "secret", CUSTOM_KEY: "secret", HOME: "/host" }, ["LANG", "CI", "GITHUB_TOKEN", "CUSTOM_KEY", "HOME"]);
	assert.deepEqual(env, { LANG: "en_US.UTF-8", CI: "1" });
	assert.equal(isSensitiveEnvironmentName("DB_PASSWORD"), true);
	assert.equal(isSensitiveEnvironmentName("MONKEY"), false);
});

test("invalid policy shapes fail closed", () => {
	for (const config of [
		{ workspaceRoot: 42 },
		{ cacheRoot: "" },
		{ network: null },
		{ environment: [] },
		{ filesystem: "invalid" },
	]) assert.throws(() => mergeConfig(config as never, undefined), /workspaceRoot|cacheRoot|network|environment|filesystem/);
});

test("project config can only narrow global capabilities", () => {
	const config = mergeConfig(
		{ network: { allow: ["github.com", "registry.npmjs.org"] }, environment: { allow: ["LANG", "CI"] } },
		{ network: { allow: ["github.com", "evil.example"] }, environment: { allow: ["LANG", "TOKEN"] } },
	);
	assert.deepEqual(config.network.allow, ["github.com"]);
	assert.deepEqual(config.environment.allow, ["LANG"]);
});

test("project config can disable but cannot enable shared caches", () => {
	const config = mergeConfig(
		{ cache: { npm: false, pip: true } },
		{ cache: { npm: true, pip: false } },
	);
	assert.equal(config.cache.npm, false);
	assert.equal(config.cache.pip, false);
	assert.deepEqual(buildCacheEnv(config.cache), {
		PNPM_HOME: "/cache/pnpm",
		CARGO_HOME: "/cache/cargo",
		GOCACHE: "/cache/go/build",
		GOMODCACHE: "/cache/go/pkg/mod",
	});
});

test("network policy allows only HTTPS reads and Git fetch", () => {
	assert.equal(DEFAULT_CONFIG.network.allow.includes("dl-cdn.alpinelinux.org"), true);
	assert.equal(
		formatNetworkAuditResource({ method: "GET", url: "https://user:secret@example.com/path?token=secret#value" }),
		"GET https://example.com/path",
	);
	assert.equal(isAllowedNetworkRequest({ method: "GET", url: "https://registry.npmjs.org/pkg" }), true);
	assert.equal(isAllowedNetworkRequest({ method: "POST", url: "https://github.com/org/repo.git/git-upload-pack" }), true);
	for (const request of [
		{ method: "PUT", url: "https://registry.npmjs.org/pkg" },
		{ method: "POST", url: "https://api.github.com/repos/org/repo/issues" },
		{ method: "GET", url: "http://registry.npmjs.org/pkg" },
		{ method: "GET", url: "https://registry.npmjs.org:8443/pkg" },
		{ method: "GET", url: "not a URL" },
	]) assert.equal(isAllowedNetworkRequest(request), false, `${request.method} ${request.url}`);
});

test("unknown tools and snapshot secrets fail closed", () => {
	assert.equal(classifyTool("docker"), "unknown");
	assert.deepEqual(filterActiveTools(["read", "docker", "read"]), { active: ["read"], blocked: ["docker"] });
	for (const path of [".env", "config/.env.local", "cert.pem", "keys/id_rsa", ".pi/extensions/evil.ts", "../escape"]) {
		assert.equal(isDeniedSnapshotPath(path), true, path);
	}
	assert.equal(isDeniedSnapshotPath("private/value.txt", ["private/**"]), true);
	assert.equal(isDeniedSnapshotPath("src/index.ts"), false);
});
