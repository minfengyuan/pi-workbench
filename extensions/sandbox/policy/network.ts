export function formatNetworkAuditResource(request: Pick<Request, "method" | "url">): string {
	const method = request.method.toUpperCase();
	try {
		const url = new URL(request.url);
		return `${method} ${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return `${method} invalid-url`;
	}
}

export function isAllowedNetworkRequest(request: Pick<Request, "method" | "url">): boolean {
	try {
		const method = request.method.toUpperCase();
		const url = new URL(request.url);
		const https443 = url.protocol === "https:" && (url.port === "" || url.port === "443");
		const readOnlyMethod = method === "GET" || method === "HEAD" || method === "OPTIONS";
		const gitFetch = method === "POST" && url.pathname.endsWith("/git-upload-pack");
		return https443 && (readOnlyMethod || gitFetch);
	} catch {
		return false;
	}
}
