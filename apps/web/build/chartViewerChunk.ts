import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const PUBLIC_ID = "virtual:chart-viewer-url";
const RESOLVED_ID = `\0${PUBLIC_ID}`;

/** Supply the actual compiled asset URL without eagerly importing the viewer. */
export function chartViewerChunkPlugin(): Plugin {
	let building = false;
	return {
		name: "chart-viewer-retry-url",
		configResolved(config) {
			building = config.command === "build";
		},
		resolveId(id) {
			return id === PUBLIC_ID ? RESOLVED_ID : null;
		},
		load(id) {
			if (id !== RESOLVED_ID) return null;
			if (!building) return 'export default "/src/chartViewer/ChartViewer.tsx";';
			const reference = this.emitFile({
				type: "chunk",
				id: fileURLToPath(new URL("../src/chartViewer/ChartViewer.tsx", import.meta.url)),
				name: "ChartViewer",
			});
			return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
		},
	};
}
