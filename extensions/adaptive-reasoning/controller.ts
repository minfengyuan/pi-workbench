import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const LEASE_STEPS = [1, 2, 5, 10] as const;
export interface Decision { level: ThinkingLevel; leaseSteps: number }

/** Pure generation lease and user baseline state. No Pi or provider side effects. */
export class AdaptiveController {
	enabled = false;
	baseline: ThinkingLevel;
	decision?: Decision & { remaining: number };
	step = 0;
	revision = 0;
	paused?: string;
	latestUserPrompt = "";
	toolFailures = 0;
	readonly expectedTransitions: { from: ThinkingLevel; to: ThinkingLevel }[] = [];

	constructor(baseline: ThinkingLevel) { this.baseline = baseline; }
	invalidate(): void { this.revision++; this.decision = undefined; }
	newTask(prompt: string): void {
		this.invalidate(); this.paused = undefined; this.latestUserPrompt = prompt;
		this.step = 0; this.toolFailures = 0;
	}
	finishGeneration(failures = 0): void {
		this.step++;
		if (this.decision) this.decision.remaining--;
		this.toolFailures += failures;
		if (failures) this.invalidate();
	}
	canReuse(): boolean { return Boolean(this.decision && this.decision.remaining > 0); }
	accept(decision: Decision, revision: number): boolean {
		if (revision !== this.revision || !this.enabled || this.paused) return false;
		this.decision = { ...decision, remaining: decision.leaseSteps };
		this.toolFailures = 0;
		return true;
	}
	select(level: ThinkingLevel, previousLevel: ThinkingLevel): boolean {
		const expected = this.expectedTransitions.findIndex((t) => t.from === previousLevel && t.to === level);
		if (expected !== -1) { this.expectedTransitions.splice(expected, 1); return false; }
		this.baseline = level;
		this.invalidate(); this.paused = "manual override";
		return true;
	}
	fail(reason = "Jev failure"): void { this.invalidate(); this.paused = reason; }
}
