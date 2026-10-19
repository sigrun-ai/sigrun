import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./auth/AuthGate";
import "./app.css";

// The bundle's entry document guarantees the mount point (index.html); a
// missing one is a broken bundle, so fail loud rather than render nothing.
const container = document.getElementById("root");
if (container === null) {
	throw new Error("sigrun webui: #root mount point missing from index.html");
}

createRoot(container).render(
	<StrictMode>
		<AuthGate />
	</StrictMode>,
);
