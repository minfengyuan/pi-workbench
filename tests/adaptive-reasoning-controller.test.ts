import assert from "node:assert/strict";
import test from "node:test";
import { AdaptiveController } from "../extensions/adaptive-reasoning/controller.ts";
import { parseConfig } from "../extensions/adaptive-reasoning/config.ts";

test("leases count generations including the next, not tool calls", () => {
	for (const steps of [1, 2, 5, 10]) {
		const c = new AdaptiveController("medium"); c.enabled = true; c.newTask("goal");
		assert.equal(c.accept({ level: "low", leaseSteps: steps }, c.revision), true);
		for (let n = 1; n <= steps; n++) { c.finishGeneration(); assert.equal(c.canReuse(), n < steps); }
	}
});
test("failures and input invalidate; stale decisions never apply", () => {
	const c = new AdaptiveController("medium"); c.enabled = true; c.newTask("goal"); const rev = c.revision;
	c.accept({ level: "low", leaseSteps: 5 }, rev); c.finishGeneration(2);
	assert.equal(c.canReuse(), false); assert.equal(c.toolFailures, 2);
	assert.equal(c.accept({ level: "high", leaseSteps: 1 }, rev), false);
	c.fail(); assert.equal(c.baseline, "medium"); assert.ok(c.paused);
	c.newTask("next"); assert.equal(c.paused, undefined); assert.equal(c.latestUserPrompt, "next");
});
test("own transitions preserve lease, manual changes replace baseline and pause task", () => {
	const c = new AdaptiveController("medium"); c.enabled = true;
	c.accept({ level: "high", leaseSteps: 2 }, c.revision); c.expectedTransitions.push({ from: "medium", to: "high" });
	assert.equal(c.select("high", "medium"), false); assert.equal(c.canReuse(), true);
	assert.equal(c.select("low", "high"), true); assert.equal(c.baseline, "low"); assert.equal(c.canReuse(), false);
	assert.equal(c.paused, "manual override"); c.newTask("next"); assert.equal(c.paused, undefined);
});
test("global config defaults to opt in and rejects invalid lease limits", () => {
	assert.deepEqual(parseConfig(null), { enabled: false, maxLeaseSteps: 10 });
	assert.deepEqual(parseConfig({ enabled: true, maxLeaseSteps: 2 }), { enabled: true, maxLeaseSteps: 2 });
	for (const value of [{ enabled: "true" }, { maxLeaseSteps: 3 }, []]) assert.throws(() => parseConfig(value));
});
