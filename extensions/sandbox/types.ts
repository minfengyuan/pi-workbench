export type SandboxMode = "dev" | "off";

export interface SandboxConfig {
	mode: SandboxMode;
	workspaceRoot: string;
	network: { allow: string[] };
	environment: { allow: string[] };
	filesystem: { denyRead: string[] };
}

export interface WorkspaceSnapshot {
	hostSource: string;
	path: string;
	baselinePath: string;
	baseCommit: string;
	snapshotCommit: string;
	dirty: boolean;
	files: number;
	createdAt: number;
}

export interface SandboxState {
	status: "off" | "starting" | "ready" | "destroyed" | "error";
	instanceId?: string;
	workspace?: WorkspaceSnapshot;
	blockedTools: string[];
	error?: string;
}
