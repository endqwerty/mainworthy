import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { queryClient } from "./lib/data.ts";
import "./base.css";

const root = document.getElementById("root");
if (!root) throw new Error("The Casebook HTML must contain #root");
createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<App />
	</QueryClientProvider>,
);
