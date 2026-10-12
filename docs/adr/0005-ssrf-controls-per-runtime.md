# ADR-0005: SSRF controls differ by runtime

**Status:** Accepted; the Worker bullet is amended for local operation by [ADR-0006](0006-local-first-operation.md) · **Date:** 2026-10-11

## Context

Section 9.5 requires network-level egress protection against DNS rebinding/TOCTOU for URL fetching, and says to fall back to an approved-host allowlist where connection-time restrictions are unavailable. URLs are fetched in two places: the Worker (source preview/registration) and the local runner (feed ingestion and research tools).

## Decision

Both runtimes share the pure string policy (`validateFetchUrl`: https only, no credentials, no explicit port, no IP literals in any notation, no internal names) and re-apply it to every redirect hop, with byte and time limits.

- **Runner (Node, on the owner's PC — the high-risk side).** The fetcher resolves the hostname, rejects the request unless *every* resolved address is globally routable (`classifyIpAddress`), and then connects to that exact validated address while keeping SNI, certificate verification and `Host` for the hostname. Because the socket goes to the address that was checked, a second DNS answer cannot redirect it. In addition every tool passes an explicit host allowlist: news tools may contact only hosts of subscribed sources; SEC tools only `sec.gov` hosts.
- **Worker.** A Worker cannot resolve DNS or pin an address. Its controls are the string policy, per-hop validation and limits; it executes on Cloudflare's network, not on the owner's LAN, so the owner's private network is not reachable from it. This is weaker than connection-time pinning and is recorded as a known limitation rather than claimed as equivalent.

## Consequences

The Worker fetches only on explicit owner action (preview/register) and is rate-limited per owner. If a stricter guarantee is later required, previews can be moved to the runner or restricted to an approved-host allowlist without changing the `SafeFetcher` port.
