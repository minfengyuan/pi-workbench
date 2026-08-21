const SENSITIVE_NAME = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIALS?)(?:_|$)/i;
const SENSITIVE_PREFIX = /^(?:AWS_|GITHUB_|OPENAI_|ANTHROPIC_|NPM_|SSH_)/i;
const GUEST_RUNTIME_NAMES = new Set(["PATH", "HOME", "TMPDIR", "PWD"]);

export function isSensitiveEnvironmentName(name: string): boolean {
	return SENSITIVE_NAME.test(name) || SENSITIVE_PREFIX.test(name);
}

export function buildGuestEnv(hostEnv: NodeJS.ProcessEnv, allow: readonly string[]): Record<string, string> {
	const guest: Record<string, string> = {};
	for (const name of allow) {
		const value = hostEnv[name];
		if (typeof value === "string" && !isSensitiveEnvironmentName(name) && !GUEST_RUNTIME_NAMES.has(name)) guest[name] = value;
	}
	return guest;
}
