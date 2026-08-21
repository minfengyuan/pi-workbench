export type PermissionMode = "read-only" | "workspace-write" | "full-access";

export type ToolCapability = "read" | "workspace-write" | "network-read" | "full";

export interface PermissionConfig {
	defaultMode: Exclude<PermissionMode, "full-access">;
	readRoots: string[];
	allowSensitivePaths: string[];
	tools: Record<string, ToolCapability>;
	disabledTools: string[];
}

export type PolicyDecision =
	| { kind: "allow" }
	| { kind: "deny"; reason: string }
	| { kind: "confirm"; reason: string };

export interface PersistedPermissionState {
	version: 1;
	mode: PermissionMode;
}
