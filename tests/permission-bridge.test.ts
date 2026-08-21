import assert from "node:assert/strict";
import test from "node:test";
import {
	getIntegrationState,
	setPlanModeActive,
	setSandboxActive,
	subscribeIntegrationState,
} from "../extensions/permission-mode/runtime-bridge.ts";

test("permission integration bridge is load-order independent and monotonic", () => {
	setPlanModeActive(false);
	setSandboxActive(false);
	const observed: string[] = [];
	const unsubscribe = subscribeIntegrationState((state) => observed.push(`${state.planMode}:${state.sandbox}`));
	setSandboxActive(true);
	setPlanModeActive(true);
	assert.deepEqual(getIntegrationState(), { planMode: true, sandbox: true });
	assert.deepEqual(observed, ["false:false", "false:true", "true:true"]);
	unsubscribe();
	setPlanModeActive(false);
	setSandboxActive(false);
	assert.equal(observed.length, 3);
});
