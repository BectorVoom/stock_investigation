/** Separate foreground Node process keeps capture state out of the exporter. */
import { coverageTurns } from "./coverage.ts";
import { generatedTurns } from "./generated.ts";

await generatedTurns();
await coverageTurns();
