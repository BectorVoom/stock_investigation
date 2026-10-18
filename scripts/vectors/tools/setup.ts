import { expect } from "vitest";

process.env.TOOLS_CAPTURE_NAMESPACE = expect.getState().testPath;
