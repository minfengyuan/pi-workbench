import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";
import { LEASE_STEPS } from "./controller.ts";

export interface AdaptiveConfig { enabled: boolean; maxLeaseSteps: number }
export const DEFAULT_CONFIG: AdaptiveConfig = { enabled: false, maxLeaseSteps: 10 };
export function parseConfig(value: unknown): AdaptiveConfig {
	if (value == null) return { ...DEFAULT_CONFIG };
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid adaptive reasoning config");
	const raw = value as Record<string, unknown>;
	const enabled = raw.enabled ?? false;
	const maxLeaseSteps = raw.maxLeaseSteps ?? 10;
	if (typeof enabled !== "boolean" || !LEASE_STEPS.includes(maxLeaseSteps as 1)) throw new Error("Invalid adaptive reasoning config");
	return { enabled, maxLeaseSteps: maxLeaseSteps as number };
}
export async function loadConfig(agentDir = getAgentDir()): Promise<AdaptiveConfig> {
	try { return parseConfig(parse(await readFile(join(agentDir, "adaptive-reasoning.yaml"), "utf8"))); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
		throw error;
	}
}
