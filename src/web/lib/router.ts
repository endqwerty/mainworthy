import { useSyncExternalStore } from "react";

export type Screen = "suite" | "case" | "queue" | "runs" | "changes" | "settings";
export type Route = { project: string; screen: Screen; ref: string | null; folder: string | null };
const changed = "mainworthy:route";
let entry: "initial" | "navigation" | "history" = "initial";
export const routeEntry = (): typeof entry => entry;
function subscribe(listener: () => void): () => void {
	const popped = () => {
		entry = "history";
		listener();
	};
	window.addEventListener("popstate", popped);
	window.addEventListener(changed, listener);
	return () => {
		window.removeEventListener("popstate", popped);
		window.removeEventListener(changed, listener);
	};
}
export function readRoute(): Route {
	const parts = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
	const project = parts[0] === "p" ? (parts[1] ?? "scratch") : "scratch";
	const segment = parts[2];
	const screen: Screen =
		segment === "queue" || segment === "runs" || segment === "changes" || segment === "settings"
			? segment
			: parts[3] === "c"
				? "case"
				: "suite";
	const value = screen === "case" ? parts[4] : parts[3];
	const ref = value
		? screen === "case"
			? `C-${value}`
			: screen === "queue"
				? `Q-${value}`
				: screen === "runs"
					? `R-${value}`
					: value
		: null;
	return { project, screen, ref, folder: new URLSearchParams(location.search).get("folder") };
}
export function useRoute(): Route {
	useSyncExternalStore(subscribe, () => location.pathname + location.search);
	return readRoute();
}
export function routeUrl({
	project,
	screen,
	ref,
	folder,
}: {
	project: string;
	screen: Screen;
	ref?: string | null;
	folder?: string | null;
}): string {
	const suffix = ref
		? screen === "case"
			? `/c/${ref.replace(/^C-/, "")}`
			: `/${encodeURIComponent(ref.replace(/^[QR]-/, ""))}`
		: "";
	return `/p/${encodeURIComponent(project)}/${screen === "case" ? "suite" : screen}${suffix}${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`;
}
export function refUrl({ project, ref }: { project: string; ref: string }): string {
	const screen: Screen = ref.startsWith("C-")
		? "case"
		: ref.startsWith("Q-")
			? "queue"
			: ref.startsWith("R-")
				? "runs"
				: "changes";
	return routeUrl({ project, screen, ref });
}
/** Changes selection without a document load. Editors receive a leave event before the URL changes. */
export function navigate(path: string, options: { replace?: boolean; seal?: boolean } = {}): void {
	if (path === location.pathname + location.search) return;
	if (options.seal !== false) window.dispatchEvent(new Event("mainworthy:leave"));
	entry = "navigation";
	if (options.replace) history.replaceState(null, "", path);
	else history.pushState(null, "", path);
	window.dispatchEvent(new Event(changed));
}
