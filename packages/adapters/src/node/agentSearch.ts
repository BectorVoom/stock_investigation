import { request } from "node:http";
import type { SafeFetchError, SafeFetcher } from "@research/application";
import { err, ok } from "@research/domain";
import { agentSearchEndpoint } from "../tools/agentSearchEndpoint.ts";

/** Private transport for one configured loopback POST. Never a public URL fetcher. */
export function createLoopbackSearchFetcher(base: string): SafeFetcher {
	const searchEndpoint = agentSearchEndpoint(base);
	if (searchEndpoint === null)
		throw new Error("AGENT_WEB_SEARCH_URL must be a literal loopback HTTP origin");
	const extractEndpoint = new URL("/extract", searchEndpoint).href;
	return {
		async fetchText(url, options) {
			if (options.signal?.aborted)
				return err({ code: "TIMEOUT", detail: "Agent Web Search request was cancelled" });
			if (url !== searchEndpoint && url !== extractEndpoint)
				return err({
					code: "UNSAFE_URL",
					detail: "Only configured search and extraction endpoints are permitted",
				});
			if (options.allowedHosts !== undefined && !options.allowedHosts.has(new URL(url).hostname))
				return err({
					code: "HOST_NOT_ALLOWED",
					detail: "Configured search host is not on the caller allowlist",
				});
			if (
				options.jsonBody === undefined ||
				Buffer.byteLength(options.jsonBody) > 65536 ||
				!/^Bearer [\x21-\x7e]{16,256}$/.test(options.authorization ?? "")
			)
				return err({ code: "NETWORK_ERROR", detail: "Invalid Agent Web Search request" });
			return new Promise((resolve) => {
				let settled = false;
				const chunks: Buffer[] = [];
				let bytes = 0;
				const finish = (failure: SafeFetchError | null, text = "") => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					options.signal?.removeEventListener("abort", abort);
					resolve(
						failure === null
							? ok({ finalUrl: url, contentType: "application/json", text })
							: err(failure),
					);
					outgoing.destroy();
				};
				const outgoing = request(
					url,
					{
						method: "POST",
						headers: {
							Authorization: options.authorization ?? "",
							Accept: "application/json",
							"Accept-Encoding": "identity",
							"Content-Type": "application/json",
							"Content-Length": Buffer.byteLength(options.jsonBody ?? ""),
						},
					},
					(response) => {
						// Install before rejecting headers: destroying an unread error body
						// can itself emit an IncomingMessage error.
						response.once("error", () =>
							finish({ code: "NETWORK_ERROR", detail: "Agent Web Search response interrupted" }),
						);
						const status = response.statusCode ?? 502;
						if (status < 200 || status >= 300) {
							const retryAfter = response.headers["retry-after"];
							finish({
								code: "HTTP_ERROR",
								status,
								detail: `HTTP ${status}`,
								...(typeof retryAfter === "string" && retryAfter.length <= 300
									? { retryAfter }
									: {}),
							});
							return;
						}
						if (
							response.headers["content-encoding"] !== undefined &&
							response.headers["content-encoding"] !== "identity"
						) {
							finish({ code: "NETWORK_ERROR", detail: "Unexpected search content encoding" });
							return;
						}
						response.on("data", (chunk: unknown) => {
							if (!Buffer.isBuffer(chunk)) {
								finish({ code: "NETWORK_ERROR", detail: "Invalid search response chunk" });
								return;
							}
							bytes += chunk.length;
							if (bytes > Math.min(options.maxBytes, 1_000_000)) {
								finish({
									code: "RESPONSE_TOO_LARGE",
									detail: "Agent Web Search response too large",
								});
								return;
							}
							chunks.push(chunk);
						});
						response.once("end", () => {
							try {
								finish(
									null,
									new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
								);
							} catch {
								finish({ code: "NETWORK_ERROR", detail: "Search response is not UTF-8" });
							}
						});
					},
				);
				const abort = () =>
					finish({
						code: "TIMEOUT",
						detail: "Agent Web Search request timed out or was cancelled",
					});
				const timer = setTimeout(abort, Math.min(options.timeoutMs, 30_000));
				outgoing.once("error", () =>
					finish({ code: "NETWORK_ERROR", detail: "Agent Web Search connection failed" }),
				);
				options.signal?.addEventListener("abort", abort, { once: true });
				if (options.signal?.aborted) {
					abort();
					return;
				}
				outgoing.end(options.jsonBody);
			});
		},
	};
}
