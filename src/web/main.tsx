import "./lib/former-name.ts";
import "./lib/no-eval.ts";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { queryClient } from "./lib/data.ts";
import { storedDraftOwners } from "./lib/drafts.ts";
import { initializeDraftOwners } from "./lib/ids.ts";
import "./base.css";

const root = document.getElementById("root");
if (!root) throw new Error("The Mainworthy HTML must contain #root");
await initializeDraftOwners(storedDraftOwners);
createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<App />
	</QueryClientProvider>,
);
