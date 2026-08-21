import type { PermissionMode, PolicyDecision } from "../types.ts";

const SHELL_META = /(?:^|[^\\])(?:&&|\|\||[;|`]|\$\(|\n|\r|>>|(?<!<)>)/;
const READ_ONLY = /^\s*(?:cat|head|tail|less|more|grep|rg|find|fd|ls|pwd|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|uname|whoami|id|date|cal|uptime|ps|top|htop|free|jq|bat|eza)(?:\s|$)/i;
const VERSION_ONLY = /^\s*(?:node|python\d*|ruby|go|rustc|cargo|npm|pnpm|yarn)\s+(?:--version|-v)\s*$/i;
const GIT_READ = /^\s*git(?:\s+-\S+)*\s+(?:status|diff|log|show|ls-(?:files|tree|remote))(?:\s+[^;&|`$<>]*)?\s*$/i;
const GIT_ADD = /^\s*git(?:\s+-\S+)*\s+add(?:\s|$)/i;
const GIT_MUTATION = /^\s*git(?:\s+-\S+)*\s+(?:commit|checkout|switch|restore|stash|merge|rebase|cherry-pick|fetch|pull|reset|clean|push|remote)(?:\s|$)/i;
const PACKAGE_SCRIPT = /^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+\S+|test|install|ci|add|remove|update|publish)(?:\s|$)/i;
const DESTRUCTIVE = /(?:^|\s)(?:rm|rmdir|chmod|chown|chgrp|truncate|dd|shred|sudo|su|kill|pkill|killall|systemctl|service)(?:\s|$)/i;
const SIMPLE_LOCAL_MUTATION = /^\s*(?:mkdir|touch|cp|mv)\s+(?:(?:-[A-Za-z]+)\s+)*(?!.*(?:^|\s)(?:\/|\.\.\/))[^;&|`$<>\n\r]+$/i;
const DANGEROUS_READ_FLAGS = /(?:\bfind\b.*(?:-delete|-exec(?:dir)?|-ok(?:dir)?|-fprint)|\bsort\b.*(?:\s-o\s|--output)|\bdiff\b.*--output)/i;
const PATH_ESCAPE = /(?:^|\s)(?:\/|~(?:\/|\s|$)|\.\.(?:\/|\s|$)|file:)|\$[{A-Za-z_]/i;
const SENSITIVE_PATH = /(?:^|[\/\s])(?:\.env(?:\.[^\s/]*)?|credentials?(?:\.[^\s/]*)?|tokens?(?:\.[^\s/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^\s/]+\.(?:pem|key|p12|pfx))(?:\s|$)/i;

function isNetworkRead(command: string): boolean {
	const tokens = command.split(/\s+/);
	const executable = tokens.shift()?.toLowerCase();
	if (executable === "wget") {
		return tokens.length === 3 && tokens[0] === "-O" && tokens[1] === "-" && /^https?:\/\//i.test(tokens[2] ?? "");
	}
	if (executable !== "curl") return false;
	let hasUrl = false;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		if (/^https?:\/\//i.test(token)) { hasUrl = true; continue; }
		if (["-s", "-S", "-L", "-I", "--silent", "--show-error", "--location", "--head", "--fail"].includes(token)) continue;
		return false;
	}
	return hasUrl;
}

export function classifyShell(command: string, mode: PermissionMode): PolicyDecision {
	if (mode === "full-access") return { kind: "allow" };
	const trimmed = command.trim();
	if (trimmed === "") return { kind: "deny", reason: "empty shell command" };
	if (PATH_ESCAPE.test(trimmed) || SENSITIVE_PATH.test(trimmed)) {
		return mode === "read-only"
			? { kind: "deny", reason: "command references an unvalidated or sensitive path" }
			: { kind: "confirm", reason: "command references a path that cannot be confined to the workspace" };
	}
	if (SHELL_META.test(trimmed) || DANGEROUS_READ_FLAGS.test(trimmed)) {
		return mode === "read-only"
			? { kind: "deny", reason: "compound commands, write flags, and redirection are not read-only" }
			: { kind: "confirm", reason: "compound command, write flag, or redirection has an uncertain write boundary" };
	}
	if (GIT_READ.test(trimmed) || READ_ONLY.test(trimmed) || VERSION_ONLY.test(trimmed) || isNetworkRead(trimmed)) {
		return { kind: "allow" };
	}
	if (mode === "read-only") return { kind: "deny", reason: "command is not on the read-only allowlist" };
	if (GIT_ADD.test(trimmed) || SIMPLE_LOCAL_MUTATION.test(trimmed)) return { kind: "allow" };
	if (GIT_MUTATION.test(trimmed)) return { kind: "confirm", reason: "Git operation may mutate files, history, or a remote" };
	if (PACKAGE_SCRIPT.test(trimmed)) return { kind: "confirm", reason: "package and build scripts can execute arbitrary code" };
	if (DESTRUCTIVE.test(trimmed)) return { kind: "confirm", reason: "destructive or system command" };
	return { kind: "confirm", reason: "command write boundary cannot be proven" };
}
