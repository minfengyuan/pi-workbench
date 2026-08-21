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
