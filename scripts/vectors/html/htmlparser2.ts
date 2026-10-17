/**
 * The exact htmlparser2 12.0.0 and entities 8.1.0 builds the converter runs
 * on (`packages/adapters` resolves `htmlparser2` to this directory). Imported
 * by path because neither package is a dependency of the repository root.
 */
export {
	DecodingMode,
	EntityDecoder,
	htmlDecodeTree,
} from "../../../node_modules/.bun/entities@8.1.0/node_modules/entities/dist/decode.js";
export { Parser } from "../../../node_modules/.bun/htmlparser2@12.0.0/node_modules/htmlparser2/dist/index.js";
