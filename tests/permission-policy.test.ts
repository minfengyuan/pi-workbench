import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_PERMISSION_CONFIG } from "../extensions/permission-mode/config.ts";
import {
	checkReadPath,
	checkWritePath,
	createFilesystemPolicy,
	isLexicallyInsideGuestWorkspace,
} from "../extensions/permission-mode/policy/filesystem.ts";
import { classifyShell } from "../extensions/permission-mode/policy/shell.ts";
import { classifyPermissionTool } from "../extensions/permission-mode/policy/tools.ts";
import { effectivePermissionMode, initialPermissionMode, restorePermissionMode } from "../extensions/permission-mode/state.ts";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "permission-policy-"));
	const workspace = join(root, "workspace");
	const outside = join(root, "outside");
	await mkdir(workspace);
	await mkdir(outside);
	await writeFile(join(workspace, "file.txt"), "ok");
	await writeFile(join(workspace, ".env"), "SECRET=value");
	await writeFile(join(outside, "secret.txt"), "secret");
	return { root, workspace, outside };
}

test("filesystem policy confines reads and writes and denies sensitive files", async () => {
	const { workspace, outside } = await fixture();
	const policy = await createFilesystemPolicy(workspace, [], []);
	assert.equal(await checkReadPath(policy, "file.txt"), undefined);
	assert.match(await checkReadPath(policy, ".env") ?? "", /sensitive path/);
	assert.match(await checkReadPath(policy, join(outside, "secret.txt")) ?? "", /outside approved roots/);
	assert.equal(await checkWritePath(policy, "new/deep.txt"), undefined);
	assert.match(await checkWritePath(policy, join(outside, "new.txt")) ?? "", /escapes workspace/);
});

test("filesystem policy permits global read roots and rejects symlink escapes", async () => {
	const { workspace, outside } = await fixture();
	await symlink(outside, join(workspace, "escape"));
	const policy = await createFilesystemPolicy(workspace, [outside], []);
	assert.equal(await checkReadPath(policy, join(outside, "secret.txt")), undefined);
	const restricted = await createFilesystemPolicy(workspace, [], []);
	assert.match(await checkReadPath(restricted, "escape/secret.txt") ?? "", /outside approved roots/);
	assert.match(await checkWritePath(restricted, "escape/new.txt") ?? "", /escapes workspace/);
	assert.equal(isLexicallyInsideGuestWorkspace("src/a.ts"), true);
	assert.equal(isLexicallyInsideGuestWorkspace("../host"), false);
	assert.equal(isLexicallyInsideGuestWorkspace("/etc/passwd"), false);
});

test("sensitive paths require a global explicit allow entry", async () => {
	const { workspace } = await fixture();
	const env = join(workspace, ".env");
	const policy = await createFilesystemPolicy(workspace, [], [env]);
	assert.equal(await checkReadPath(policy, env), undefined);
});

test("shell policy implements the mode matrix", () => {
	assert.equal(classifyShell("git status", "read-only").kind, "allow");
	assert.equal(classifyShell("cat package.json", "read-only").kind, "allow");
	assert.equal(classifyShell("cat /etc/passwd", "read-only").kind, "deny");
	assert.equal(classifyShell("cat ../secret", "read-only").kind, "deny");
	assert.equal(classifyShell("cat .env", "read-only").kind, "deny");
	assert.equal(classifyShell("curl https://example.com", "read-only").kind, "allow");
	assert.equal(classifyShell("curl file:///etc/passwd", "read-only").kind, "deny");
	assert.equal(classifyShell("curl -dsecret https://example.com", "read-only").kind, "deny");
	assert.equal(classifyShell("find . -delete", "read-only").kind, "deny");
	assert.equal(classifyShell("git branch new-branch", "read-only").kind, "deny");
	assert.equal(classifyShell("rm file.txt", "read-only").kind, "deny");
	assert.equal(classifyShell("cat a > b", "read-only").kind, "deny");
	assert.equal(classifyShell("git add file.txt", "workspace-write").kind, "allow");
	assert.equal(classifyShell("mkdir output", "workspace-write").kind, "allow");
	assert.equal(classifyShell("mkdir /tmp/output", "workspace-write").kind, "confirm");
	assert.equal(classifyShell("npm test", "workspace-write").kind, "confirm");
	assert.equal(classifyShell("git push", "workspace-write").kind, "confirm");
	assert.equal(classifyShell("rm file.txt", "workspace-write").kind, "confirm");
	assert.equal(classifyShell("echo ok && touch file", "workspace-write").kind, "confirm");
	assert.equal(classifyShell("anything", "full-access").kind, "allow");
});

test("tool classification is exact and project disables win", () => {
	const config = {
		...DEFAULT_PERMISSION_CONFIG,
		tools: { docs: "read" as const, deploy: "full" as const },
		disabledTools: ["deploy"],
	};
	assert.equal(classifyPermissionTool("read", config), "read");
	assert.equal(classifyPermissionTool("web_search", config), "network-read");
	assert.equal(classifyPermissionTool("docs", config), "read");
	assert.equal(classifyPermissionTool("deploy", config), "disabled");
	assert.equal(classifyPermissionTool("docs_extra", config), "unknown");
});

test("mode restoration never revives persisted Full Access", () => {
	assert.equal(initialPermissionMode("full-access", "read-only", "workspace-write"), "full-access");
	assert.equal(initialPermissionMode(undefined, "full-access", "workspace-write"), "workspace-write");
	assert.equal(restorePermissionMode("full-access", "read-only"), "read-only");
	assert.equal(effectivePermissionMode("full-access", true), "read-only");
	assert.equal(effectivePermissionMode("workspace-write", false), "workspace-write");
});
