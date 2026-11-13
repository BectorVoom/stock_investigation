# ADR-0073: Agent Web Search replaces Tavily in normal runners

Date:2026-11-12. Status:accepted.

The Rust service in the separate agent-web-search repository provides a compatible
search envelope and owns its local index/SearXNG discovery. Normal Rust and Node
runner composition now uses that service for web.search and passes no Tavily key.
The model tool identity/query contract,evidence mapping,page verification and
GDELT news.search stay intact. Legacy factory callers and golden vectors retain
the old adapter branch without an automatic runtime fallback.

A dedicated transport accepts one operator-configured literal loopback HTTP
endpoint,never a model URL. It does not weaken the public fetcher's SSRF policy,
use DNS,follow redirects,log credentials or retry a POST. Request deadline30s,
tool40s,response1MiB,request64KiB;cancellation closes transport. Service statuses
are preserved. Keys are separate from Tavily and are generated/stored in env files.

The service must run separately (`bun run search:service`); whole-web discovery
requires SearXNG or another service-side index. Imported corpus mode is not global
web search. See [API reference](../external-apis/apis/agent-web-search.md) and
[operations](../OPERATIONS.md). No database/UI/domain-algorithm change is needed.
