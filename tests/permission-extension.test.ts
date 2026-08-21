import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import permissionModeExtension from "../extensions/permission-mode/index.ts";
import { setPlanModeActive, setSandboxActive } from "../extensions/permission-mode/runtime-bridge.ts";

test("permission extension registers enforcement without intercepting direct user bash", async () => {
	setPlanModeActive(false);
	setSandboxActive(false);
	const events = new Map<string, (...args: any[]) => unknown>();
	const commands = new Map<string, { handler: (...args: any[]) => unknown }>();
	const entries: unknown[] = [];
	const api = {
		registerFlag() {},
		registerCommand(name: string, command: { handler: (...args: any[]) => unknown }) { commands.set(name, command); },
		on(name: string, handler: (...args: any[]) => unknown) { events.set(name, handler); },
		appendEntry(_type: string, data: unknown) { entries.push(data); },
		getActiveTools() { return ["read", "write", "custom"]; },
		getAllTools() { return ["read", "write", "custom"].map((name) => ({ name })); },
		setActiveTools() {},
	} as unknown as ExtensionAPI;
	permissionModeExtension(api);

	assert.ok(events.has("tool_call"));
	assert.ok(events.has("before_agent_start"));
	assert.equal(events.has("user_bash"), false);
	assert.ok(commands.has("permissions"));

	const notifications: string[] = [];
	const ctx = {
		hasUI: false,
		isIdle: () => true,
		ui: {
			confirm: async () => false,
			select: async () => undefined,
			notify: (message: string) => notifications.push(message),
			setStatus() {},
			theme: { fg: (_color: string, text: string) => text },
		},
	} as unknown as ExtensionContext;
	const blocked = await events.get("tool_call")?.({ toolName: "custom", input: {} }, ctx) as { block?: boolean; reason?: string };
	assert.equal(blocked.block, true);
	assert.match(blocked.reason ?? "", /interactive approval is unavailable/);

	let selection = "Full Access";
	const uiCtx = {
		...ctx,
		hasUI: true,
		ui: {
			...ctx.ui,
			select: async () => selection,
			confirm: async () => true,
		},
	} as unknown as ExtensionContext;
	await commands.get("permissions")?.handler("", uiCtx);
	assert.deepEqual(entries, [{ version: 1, mode: "full-access" }]);
	const allowed = await events.get("tool_call")?.({ toolName: "custom", input: {} }, uiCtx);
	assert.equal(allowed, undefined);

	selection = "Read Only";
	setPlanModeActive(true);
	await commands.get("permissions")?.handler("", uiCtx);
	assert.equal(entries.length, 1, "plan mode must prevent permission switching");
	setPlanModeActive(false);
});
