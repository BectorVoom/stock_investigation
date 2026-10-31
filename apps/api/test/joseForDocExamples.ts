/**
 * The Worker's own `jose`, for tests/security/cloudflareAccessDocExamples.test.ts:
 * the repository-root tests have no dependency on `jose`, and the Worker's tests
 * run in workerd, which cannot read the documentation files.
 */
export { createLocalJWKSet } from "jose";
