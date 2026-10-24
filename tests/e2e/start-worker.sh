#!/bin/sh
# Builds the SPA, creates a fresh local D1 from the real migrations and serves
# the E2E Worker (API + static assets) on localhost.
set -eu
cd "$(dirname "$0")/../.."
# Test isolation (finding 5, task 23b): this deterministic suite builds its own
# assets into dist/web. A hostile RESEARCH_WEB_OUT_DIR in the caller's
# environment (e.g. pointing at the production release) must never redirect
# the build — Vite empties its output directory first — and no other launcher
# or runner setting may leak into the worker, so every test-controlled
# variable but the suite's own addressing (E2E_PORT) is unset here. Launcher
# and runner processes the specs start go through scripts/testEnv.ts instead.
unset RESEARCH_WEB_OUT_DIR
unset RESEARCH_DATA_DIR RESEARCH_DEV_DATA_DIR
unset RESEARCH_RELEASE_DIR RESEARCH_PREVIOUS_RELEASE_DIR
unset RESEARCH_RUNNER_ENV_FILE
unset RESEARCH_PORT RESEARCH_DEV_PORT RESEARCH_DEV_API_PORT
unset RESEARCH_API_URL RUNNER_TOKEN RUNNER_PAGES_DIR RUNNER_SCRATCH_ROOT
unset CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET
unset SEC_USER_AGENT ALLOW_UNVERIFIED_TOOL_ISOLATION
unset OPENCODE_MODEL OPENROUTER_API_KEY OPENROUTER_MODEL OPENROUTER_FREE_MODEL ANTHROPIC_API_KEY
unset RESEARCH_ALLOW_NEWER_DB RESEARCH_RELEASE_MARKER RESEARCH_BUILD_FAIL_AT
unset RUN_LIVE_OPENCODE
STATE=".wrangler/e2e-state"
rm -rf "$STATE"
node_modules/.bin/vite build --config apps/web/vite.config.ts >/dev/null
node_modules/.bin/wrangler d1 migrations apply research --local \
	--config tests/e2e/wrangler.e2e.jsonc --persist-to "$STATE" >/dev/null
exec node_modules/.bin/wrangler dev --config tests/e2e/wrangler.e2e.jsonc \
	--port "${E2E_PORT:-8799}" --ip 127.0.0.1 --local --persist-to "$STATE" --show-interactive-dev-session=false
