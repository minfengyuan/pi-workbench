import path from "node:path";
import { createHttpHooks, RealFSProvider, VM } from "@earendil-works/gondolin";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AuditLogger } from "../audit/logger.ts";
import { buildGuestEnv } from "../policy/environment.ts";
import { isAllowedNetworkRequest } from "../policy/network.ts";
import type { SandboxConfig, WorkspaceSnapshot } from "../types.ts";
import { GUEST_WORKSPACE } from "../tools/gondolin-operations.ts";

export class GondolinBackend {
	private vm?: VM;
	private starting?: Promise<VM>;
	shellPath = "/bin/sh";

	constructor(
		private readonly config: SandboxConfig,
		private readonly snapshot: WorkspaceSnapshot,
		private readonly audit: AuditLogger,
		private readonly sessionId: string,
	) {}

	async start(ctx?: ExtensionContext): Promise<VM> {
		if (this.vm) return this.vm;
		if (this.starting) return this.starting;
		this.starting = this.create(ctx).finally(() => { this.starting = undefined; });
		return this.starting;
	}

	private async create(ctx?: ExtensionContext): Promise<VM> {
		ctx?.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", "🔒 dev | starting"));
		const { httpHooks } = createHttpHooks({
			allowedHosts: this.config.network.allow,
			blockInternalRanges: true,
			isRequestAllowed: async (request) => {
				const method = request.method.toUpperCase();
				const allowed = isAllowedNetworkRequest(request);
				if (!allowed) {
					await this.audit.write({ session: this.sessionId, event: "network.request", decision: "deny", resource: `${method} ${request.url}` });
				}
				return allowed;
			},
			onRequest: async (request) => {
				await this.audit.write({ session: this.sessionId, event: "network.request", decision: "allow", resource: request.url });
			},
		});
		const created = await VM.create({
			sessionLabel: `pi-sandbox ${path.basename(this.snapshot.hostSource)}`,
			httpHooks,
			env: buildGuestEnv(process.env, this.config.environment.allow),
			allowWebSockets: false,
			vfs: {
				mounts: { [GUEST_WORKSPACE]: new RealFSProvider(this.snapshot.path) },
			},
		});
		try {
			const gitProbe = await created.exec(["/bin/sh", "-lc", "command -v git >/dev/null || /sbin/apk add --no-cache git"]);
			if (gitProbe.exitCode !== 0) {
				throw new Error(`Failed to provision guest Git: ${gitProbe.stderr.trim() || `exit ${gitProbe.exitCode}`}`);
			}
			const gitTrust = await created.exec(["/usr/bin/git", "config", "--global", "--add", "safe.directory", GUEST_WORKSPACE]);
			if (gitTrust.exitCode !== 0) {
				throw new Error(`Failed to configure guest Git workspace: ${gitTrust.stderr.trim() || `exit ${gitTrust.exitCode}`}`);
			}
			const probe = await created.exec(["/bin/sh", "-lc", "command -v bash || true"]);
			this.shellPath = probe.stdout.trim() || "/bin/sh";
			this.vm = created;
			await this.audit.write({ session: this.sessionId, event: "sandbox.started", details: { instanceId: created.id } });
			return created;
		} catch (error) {
			await created.close();
			throw error;
		}
	}

	get instance(): VM | undefined { return this.vm; }

	async destroy(): Promise<void> {
		const active = this.vm;
		this.vm = undefined;
		this.starting = undefined;
		if (active) await active.close();
		await this.audit.write({ session: this.sessionId, event: "sandbox.destroyed" });
	}
}
