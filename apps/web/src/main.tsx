import "./styles.css";
import { createBaselineUiRegistry } from "@research/ui-registry";
import { render } from "solid-js/web";
import { App } from "./App.tsx";
import { createApiClient } from "./api/client.ts";
import { documentVisibility } from "./lib/polling.ts";

/**
 * Composition root of the SPA. A new component type is registered here:
 * `createUiRegistry([...BASELINE_REGISTRY_ENTRIES, myEntry])`.
 */
// The static shell can be reached over plain HTTP, where the API refuses to work. Move to
// HTTPS before anything else runs (the Content-Security-Policy rules out an inline script).
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];
if (
	window.location.protocol === "http:" &&
	!LOOPBACK_HOSTNAMES.includes(window.location.hostname)
) {
	window.location.replace(window.location.href.replace(/^http:/, "https:"));
}

const root = document.getElementById("root");
if (root === null) {
	throw new Error('index.html must contain an element with id "root"');
}

const api = createApiClient();
const registry = createBaselineUiRegistry();
const visibility = documentVisibility(document);

render(() => <App api={api} registry={registry} visibility={visibility} window={window} />, root);
