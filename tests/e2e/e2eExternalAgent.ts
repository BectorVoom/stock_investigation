/**
 * FR-013 stdio entry point of the E2E scripted agent: the Rust E2E runner
 * (`research-runner-e2e`) registers `node tests/e2e/e2eExternalAgent.ts` as an
 * external agent, so the prompts the Rust pipeline builds are answered by the
 * same scripted logic the Node harness uses in process.
 */
import { serveExternalAgent } from "../../examples/extensions/externalProcess/serve.ts";
import { createE2eScriptedAgent } from "./e2eScriptedAgent.ts";

await serveExternalAgent(createE2eScriptedAgent());
