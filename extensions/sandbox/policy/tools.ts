export type ExecutionDomain = "sandbox" | "host-safe" | "unknown";

const DOMAINS: Readonly<Record<string, Exclude<ExecutionDomain, "unknown">>> = {
	read: "sandbox",
	write: "sandbox",
	edit: "sandbox",
	bash: "sandbox",
	grep: "sandbox",
	find: "sandbox",
	ls: "sandbox",
	sandbox_status: "host-safe",
};

export function classifyTool(name: string): ExecutionDomain {
	return DOMAINS[name] ?? "unknown";
}

export function filterActiveTools(names: readonly string[]): { active: string[]; blocked: string[] } {
	const active: string[] = [];
	const blocked: string[] = [];
	for (const name of names) {
		(classifyTool(name) === "unknown" ? blocked : active).push(name);
	}
	return { active: [...new Set(active)], blocked: [...new Set(blocked)] };
}
