import { applyD1Migrations, env } from "cloudflare:test";

// Idempotent: applies only migrations the test database has not seen yet.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
