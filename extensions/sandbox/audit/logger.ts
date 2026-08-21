import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface AuditEvent {
	session: string;
	event: string;
	decision?: "allow" | "deny";
	resource?: string;
	details?: Record<string, unknown>;
}

export class AuditLogger {
	private readonly root: string;
	private readonly retentionDays: number;

	constructor(root = join(getAgentDir(), "sandbox-logs"), retentionDays = 30) {
		this.root = root;
		this.retentionDays = retentionDays;
	}

	private async rotate(now: Date): Promise<void> {
		const cutoff = now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000;
		for (const name of await readdir(this.root)) {
			const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
			if (match && Date.parse(`${match[1]}T00:00:00Z`) < cutoff) await rm(join(this.root, name), { force: true });
		}
	}

	async write(event: AuditEvent): Promise<void> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const now = new Date();
		await this.rotate(now);
		const date = now.toISOString().slice(0, 10);
		const line = JSON.stringify({ timestamp: now.toISOString(), ...event });
		await appendFile(join(this.root, `${date}.jsonl`), `${line}\n`, { encoding: "utf8", mode: 0o600 });
	}
}
