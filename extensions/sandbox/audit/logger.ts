import { mkdir, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AuditEvent {
	session: string;
	event: string;
	decision?: "allow" | "deny";
	resource?: string;
	details?: Record<string, unknown>;
}

export class AuditLogger {
	private readonly root: string;

	constructor(root = join(homedir(), ".pi", "agent", "sandbox-logs")) {
		this.root = root;
	}

	async write(event: AuditEvent): Promise<void> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const date = new Date().toISOString().slice(0, 10);
		const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
		await appendFile(join(this.root, `${date}.jsonl`), `${line}\n`, { encoding: "utf8", mode: 0o600 });
	}
}
