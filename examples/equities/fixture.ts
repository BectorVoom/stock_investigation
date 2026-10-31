import { equityImportSchema } from "@research/contracts";
import synthetic from "./synthetic.json" with { type: "json" };

/** The documented synthetic file is the single source for all test runtimes. */
export const equityFixture = equityImportSchema.parse(synthetic);
