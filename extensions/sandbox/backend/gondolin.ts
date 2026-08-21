import path from "node:path";
import { createHttpHooks, RealFSProvider, VM, type IngressAccess } from "@earendil-works/gondolin";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AuditLogger } from "../audit/logger.ts";
import { buildCacheEnv, prepareCacheDirectories } from "../cache/manager.ts";
import { buildGuestEnv } from "../policy/environment.ts";
import { formatNetworkAuditResource, isAllowedNetworkRequest } from "../policy/network.ts";
import type { SandboxConfig, WorkspaceSnapshot } from "../types.ts";
import { GUEST_WORKSPACE } from "../tools/gondolin-operations.ts";

export class GondolinBackend {
	private vm?: VM;
	private starting?: Promise<VM>;
	private ingress?: IngressAccess;
	private ingressStarting?: Promise<IngressAccess>;
	private ingressGuestPort?: number;
	private destroyed = false;
	private readonly config: SandboxConfig;
	private readonly snapshot: WorkspaceSnapshot;
	private readonly audit: AuditLogger;
	private readonly sessionId: string;
	private readonly createVm: typeof VM.create;
	shellPath = "/bin/sh";

	constructor(
		config: SandboxConfig,
		snapshot: WorkspaceSnapshot,
		audit: AuditLogger,
		sessionId: string,
		createVm: typeof VM.create = VM.create,
	) {
		this.config = config;
		this.snapshot = snapshot;
		this.audit = audit;
		this.sessionId = sessionId;
		this.createVm = createVm;
	}

	async start(ctx?: ExtensionContext): Promise<VM> {
		if (this.destroyed) throw new Error("Sandbox backend has been destroyed");
		if (this.vm) return this.vm;
		if (this.starting) return this.starting;
		const starting = this.create(ctx);
		this.starting = starting;
		void starting.finally(() => {
			if (this.starting === starting) this.starting = undefined;
		}).catch(() => {});
		return starting;
	}

	private async create(ctx?: ExtensionContext): Promise<VM> {
		ctx?.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", "🔒 dev | starting"));
		const { httpHooks } = createHttpHooks({
			allowedHosts: this.config.network.allow,
			blockInternalRanges: true,
			isRequestAllowed: async (request) => {
				const allowed = isAllowedNetworkRequest(request);
				if (!allowed) {
					await this.audit.write({ session: this.sessionId, event: "network.request", decision: "deny", resource: formatNetworkAuditResource(request) });
				}
				return allowed;
			},
			onRequest: async (request) => {
				await this.audit.write({ session: this.sessionId, event: "network.request", decision: "allow", resource: formatNetworkAuditResource(request) });
			},
		});
		const cacheDirectories = await prepareCacheDirectories(this.config.cacheRoot, this.config.cache, this.snapshot.hostSource);
		if (this.destroyed) throw new Error("Sandbox backend was destroyed during startup");
		const mounts = Object.fromEntries([
			[GUEST_WORKSPACE, new RealFSProvider(this.snapshot.path)],
			...Object.entries(cacheDirectories).map(([guestPath, hostPath]) => [guestPath, new RealFSProvider(hostPath)]),
		]);
		const created = await this.createVm({
			sessionLabel: `pi-sandbox ${path.basename(this.snapshot.hostSource)}`,
			httpHooks,
			env: { ...buildGuestEnv(process.env, this.config.environment.allow), ...buildCacheEnv(this.config.cache) },
			allowWebSockets: false,
			vfs: { mounts },
		});
		try {
			if (this.destroyed) throw new Error("Sandbox backend was destroyed during startup");
			const gitProbe = await created.exec(["/bin/sh", "-lc", "command -v git >/dev/null || /sbin/apk add --no-cache git"]);
			if (this.destroyed) throw new Error("Sandbox backend was destroyed during startup");
			if (gitProbe.exitCode !== 0) {
				throw new Error(`Failed to provision guest Git: ${gitProbe.stderr.trim() || `exit ${gitProbe.exitCode}`}`);
			}
			for (const [name, value] of [
				["safe.directory", GUEST_WORKSPACE],
				["user.name", "Pi Sandbox"],
				["user.email", "pi-sandbox@invalid"],
				["commit.gpgSign", "false"],
			] as const) {
				const gitConfig = await created.exec(["/usr/bin/git", "config", "--global", name, value]);
				if (this.destroyed) throw new Error("Sandbox backend was destroyed during startup");
				if (gitConfig.exitCode !== 0) {
					throw new Error(`Failed to configure guest Git workspace: ${gitConfig.stderr.trim() || `exit ${gitConfig.exitCode}`}`);
				}
			}
			if (this.snapshot.remoteUrl) {
				const remote = await created.exec(["/usr/bin/git", "-C", GUEST_WORKSPACE, "remote", "add", "origin", this.snapshot.remoteUrl]);
				if (this.destroyed) throw new Error("Sandbox backend was destroyed during startup");
				if (remote.exitCode !== 0) {
					throw new Error(`Failed to configure guest Git remote: ${remote.stderr.trim() || `exit ${remote.exitCode}`}`);
				}
			}
			const probe = await created.exec(["/bin/sh", "-lc", "command -v bash || true"]);
			if (this.destroyed) throw new Error("Sandbox backend was destroyed during startup");
			this.shellPath = probe.stdout.trim() || "/bin/sh";
			await this.audit.write({ session: this.sessionId, event: "sandbox.started", details: { instanceId: created.id } });
			if (this.destroyed) throw new Error("Sandbox backend was destroyed during startup");
			this.vm = created;
			return created;
		} catch (error) {
			await created.close();
			throw error;
		}
	}

	get instance(): VM | undefined { return this.vm; }

	async listProcesses(): Promise<string> {
		const active = await this.start();
		const result = await active.exec(["/bin/sh", "-lc", "ps -o pid,ppid,stat,args"]);
		if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Failed to list sandbox processes");
		return result.stdout.trim();
	}

	async listFiles(): Promise<string> {
		const active = await this.start();
		const result = await active.exec(["/usr/bin/git", "-C", GUEST_WORKSPACE, "status", "--short"]);
		if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Failed to list sandbox files");
		return result.stdout.trim();
	}

	async resetWorkspace(snapshotCommit: string): Promise<void> {
		const active = await this.start();
		const reset = await active.exec(["/usr/bin/git", "-C", GUEST_WORKSPACE, "reset", "--hard", snapshotCommit]);
		if (reset.exitCode !== 0) throw new Error(reset.stderr.trim() || "Failed to reset sandbox workspace");
		const clean = await active.exec(["/usr/bin/git", "-C", GUEST_WORKSPACE, "clean", "-fdx"]);
		if (clean.exitCode !== 0) throw new Error(clean.stderr.trim() || "Failed to clean sandbox workspace");
	}

	async serve(guestPort: number): Promise<string> {
		if (!Number.isSafeInteger(guestPort) || guestPort < 1 || guestPort > 65535) throw new Error("Guest port must be between 1 and 65535");
		const active = await this.start();
		if (this.destroyed) throw new Error("Sandbox backend has been destroyed");
		if (this.ingressGuestPort !== undefined && this.ingressGuestPort !== guestPort) {
			throw new Error(`Sandbox ingress already forwards guest port ${this.ingressGuestPort}`);
		}
		if (this.ingressGuestPort === undefined) {
			this.ingressGuestPort = guestPort;
			active.setIngressRoutes([{ prefix: "/", port: guestPort, stripPrefix: false }]);
		}
		if (!this.ingress && !this.ingressStarting) {
			const starting = active.enableIngress({ listenHost: "127.0.0.1", listenPort: 0, allowWebSockets: true }).then(async (access) => {
				if (this.destroyed) {
					await access.close();
					throw new Error("Sandbox backend was destroyed during ingress startup");
				}
				this.ingress = access;
				return access;
			});
			this.ingressStarting = starting;
			void starting.finally(() => {
				if (this.ingressStarting === starting) this.ingressStarting = undefined;
			}).catch(() => {});
		}
		const ingress = this.ingress ?? await this.ingressStarting!;
		if (this.destroyed) throw new Error("Sandbox backend has been destroyed");
		await this.audit.write({ session: this.sessionId, event: "network.ingress", decision: "allow", resource: `127.0.0.1:${ingress.port}->${guestPort}` });
		return ingress.url;
	}

	async destroy(): Promise<void> {
		if (this.destroyed) return;
		this.destroyed = true;
		const starting = this.starting;
		if (starting) {
			try { await starting; } catch { /* startup closes a partially-created VM */ }
		}
		const ingressStarting = this.ingressStarting;
		if (ingressStarting) {
			try { await ingressStarting; } catch { /* late ingress closes itself */ }
		}
		const ingress = this.ingress;
		this.ingress = undefined;
		this.ingressGuestPort = undefined;
		const active = this.vm;
		this.vm = undefined;
		try {
			if (ingress) await ingress.close();
		} finally {
			try {
				if (active) await active.close();
			} finally {
				await this.audit.write({ session: this.sessionId, event: "sandbox.destroyed" });
			}
		}
	}
}
