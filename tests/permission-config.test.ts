import assert from "node:assert/strict";
import test from "node:test";
import { mergePermissionConfig } from "../extensions/permission-mode/config.ts";

const rootA = "/opt/pi-docs";
const rootB = "/opt/shared";

test("permission project config can only narrow global capabilities", () => {
	const config = mergePermissionConfig(
		{
			defaultMode: "workspace-write",
			allowedReadRoots: [rootA, rootB],
			allowSensitivePaths: ["/work/project/.env"],
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
