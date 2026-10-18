/** Quota-free worked example; wave-C's harness can supply its own reply module. */
import { createScriptedAgent } from "../scriptedAgent.ts";
import { serveExternalAgent } from "./serve.ts";

await serveExternalAgent(createScriptedAgent({ reply: () => "OK 😀" }));
