import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { mergePermissionConfig, parseAddDirFlag } from "../extensions/permission-mode/config.ts";

const win = process.platform === "win32";
const host = (...parts: string[]) => win ? path.win32.join("C:\\", ...parts) : path.posix.join("/", ...parts);

const rootA = host("opt", "pi-docs");
const rootB = host("opt", "shared");
const home = host("home", "user");
const api = host("work", "api");

test("permission project config can only narrow global capabilities", () => {
	const config = mergePermissionConfig(
		{
			defaultMode: "workspace-write",
			allowedReadRoots: [rootA, rootB],
			allowSensitivePaths: [host("work", "project", ".env")],
			tools: { docs: "read", deploy: "full" },
		},
		{ defaultMode: "read-only", readRoots: [rootA], disabledTools: ["deploy"] },
	);
	assert.equal(config.defaultMode, "read-only");
	assert.deepEqual(config.readRoots, [rootA]);
	assert.deepEqual(config.tools, { docs: "read", deploy: "full" });
	assert.deepEqual(config.disabledTools, ["deploy"]);
});

test("permission config rejects project capability expansion and full defaults", () => {
	assert.throws(
		() => mergePermissionConfig({ allowedReadRoots: [rootA] }, { readRoots: [rootB] }),
		/exceed the global allowlist/,
	);
	assert.throws(() => mergePermissionConfig({ defaultMode: "full-access" }, undefined), /must be read-only or workspace-write/);
	assert.throws(() => mergePermissionConfig(undefined, { tools: { rogue: "read" } } as never), /unknown fields/);
});

test("permission config validates absolute roots, capabilities, and unknown fields", () => {
	assert.throws(() => mergePermissionConfig({ allowedReadRoots: ["relative"] }, undefined), /absolute paths/);
	assert.throws(() => mergePermissionConfig({ tools: { custom: "owner" } }, undefined), /must be read/);
	assert.throws(() => mergePermissionConfig({ surprise: true } as never, undefined), /unknown fields/);
});

test("windows paths without a drive or UNC root are not absolute", { skip: win ? false : "host paths are POSIX here" }, () => {
	assert.throws(() => mergePermissionConfig({ allowedReadRoots: ["/opt/pi-docs"] }, undefined), /absolute paths/);
	assert.throws(() => mergePermissionConfig({ allowedReadRoots: ["\\opt\\pi-docs"] }, undefined), /absolute paths/);
});

test("additionalDirectories union global and project paths and resolve relatives", () => {
	const globalDir = host("opt", "global");
	const config = mergePermissionConfig(
		{ additionalDirectories: [globalDir, "from-home"] },
		{ additionalDirectories: ["../shared"] },
		home,
		api,
	);
	assert.deepEqual(config.additionalDirectories, [globalDir, path.resolve(home, "from-home"), path.resolve(api, "../shared")]);
});

test("parseAddDirFlag splits comma-separated cwd-relative paths", () => {
	const other = host("opt", "other");
	assert.deepEqual(parseAddDirFlag("", api), []);
	assert.deepEqual(parseAddDirFlag(`../shared, ${other}`, api), [path.resolve(api, "../shared"), other]);
	assert.deepEqual(parseAddDirFlag(true, api), []);
});
