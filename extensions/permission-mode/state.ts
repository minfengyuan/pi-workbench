import type { PermissionMode } from "./types.ts";

export function initialPermissionMode(
	cliMode: PermissionMode | undefined,
	persistedMode: PermissionMode | undefined,
	defaultMode: Exclude<PermissionMode, "full-access">,
): PermissionMode {
	if (cliMode) return cliMode;
	return restorePermissionMode(persistedMode, defaultMode);
}

export function restorePermissionMode(
	persistedMode: PermissionMode | undefined,
	defaultMode: Exclude<PermissionMode, "full-access">,
): Exclude<PermissionMode, "full-access"> {
	return persistedMode === "read-only" || persistedMode === "workspace-write" ? persistedMode : defaultMode;
}

export function effectivePermissionMode(baseMode: PermissionMode, planMode: boolean): PermissionMode {
	return planMode ? "read-only" : baseMode;
}
