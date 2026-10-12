/**
 * A local TLS server for exercising the production pinned-HTTPS code path.
 *
 * `loopbackConnect` is the ONLY place a connection is steered to loopback: it
 * wraps the real `createPinnedHttpsConnect` (same TLS verification, same
 * request options) and swaps in 127.0.0.1 plus the test port and test root.
 * The address the SafeFetcher asked for is recorded first, so tests still
 * assert on the address that was validated.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import {
	createPinnedHttpsConnect,
	type PinnedConnect,
	type PinnedRequest,
} from "../../src/node/pinnedConnect.ts";
import { createSelfSignedCertificate } from "./selfSignedCert.ts";

export interface LocalTlsServer {
	readonly port: number;
	readonly certPem: string;
	close(): Promise<void>;
}

export async function startTlsServer(
	hostnames: readonly string[],
	handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<LocalTlsServer> {
	const certificate = createSelfSignedCertificate(hostnames);
	const server = createServer({ key: certificate.keyPem, cert: certificate.certPem }, handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("test server has no TCP address");
	}
	return {
		port: address.port,
		certPem: certificate.certPem,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

export interface LoopbackConnect {
	readonly connect: PinnedConnect;
	/** What the fetcher asked to connect to, before the test redirected it to loopback. */
	readonly requested: PinnedRequest[];
}

export function loopbackConnect(server: LocalTlsServer): LoopbackConnect {
	const real = createPinnedHttpsConnect({ port: server.port, ca: server.certPem });
	const requested: PinnedRequest[] = [];
	return {
		requested,
		connect: (request) => {
			requested.push(request);
			return real({ ...request, address: { address: "127.0.0.1", family: 4 } });
		},
	};
}
