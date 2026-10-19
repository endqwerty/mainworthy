import { useSyncExternalStore } from "react";

export type Screen = "suite" | "case" | "queue" | "runs" | "changes" | "tests" | "reports" | "settings";
export type Route = { project: string; screen: Screen; ref: string | null; folder: string | null };
const changed = "mainworthy:route";
let entry: "initial" | "navigation" | "history" = "initial";
export const routeEntry = (): typeof entry => entry;
let navigation = Symbol();
/** A route's ownership, lost even when somebody leaves and returns to the same address. */
export const navigationToken = (): symbol => navigation;
/**
 * Sent when somebody goes somewhere: a `navigate` that is not `replace`, also to the address the page is
 * already at. A phone listens, to show the pane of where they went (`phone.tsx`). A `replace` is nobody going
 * anywhere: the selection moved, or a case that was just recorded got its address.
 */
export const WENT = "mainworthy:went";
function subscribe(listener: () => void): () => void {
	const popped = () => {
		entry = "history";
		navigation = Symbol();
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
		segment === "queue" ||
		segment === "runs" ||
		segment === "changes" ||
		segment === "tests" ||
		segment === "reports" ||
		segment === "settings"
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
					: screen === "tests"
						? `T-${value}`
						: value
		: null;
	return { project, screen, ref, folder: new URLSearchParams(location.search).get("folder") };
}
export function useRoute(): Route {
	useSyncExternalStore(subscribe, navigationToken);
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
			: `/${encodeURIComponent(ref.replace(/^[QRT]-/, ""))}`
		: "";
	return `/p/${encodeURIComponent(project)}/${screen === "case" ? "suite" : screen}${suffix}${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`;
}
/**
 * The screen that is open, in another project. A ref, a folder and a tag are one project's and stay behind, so
 * a case that was open becomes that project's Suite. Every way of switching projects goes through here.
 */
export function projectUrl({ project, screen }: { project: string; screen: Screen }): string {
	return routeUrl({ project, screen: screen === "case" ? "suite" : screen });
}
export function refUrl({ project, ref }: { project: string; ref: string }): string {
	const screen: Screen = ref.startsWith("C-")
		? "case"
		: ref.startsWith("Q-")
			? "queue"
			: ref.startsWith("R-")
				? "runs"
				: /^T-\d+$/.test(ref)
					? "tests"
					: "changes";
	return routeUrl({ project, screen, ref });
}
/** Changes selection without a document load. Delayed callers keep their route's token in `ifCurrent`. */
export function navigate(path: string, options: { replace?: boolean; seal?: boolean; ifCurrent?: symbol } = {}): void {
	if (options.ifCurrent !== undefined && options.ifCurrent !== navigation) return;
	if (path === location.pathname + location.search) {
		if (!options.replace) {
			navigation = Symbol();
			window.dispatchEvent(new Event(changed));
			window.dispatchEvent(new Event(WENT));
		}
		return;
	}
	if (options.seal !== false) window.dispatchEvent(new Event("mainworthy:leave"));
	entry = "navigation";
	navigation = Symbol();
	if (options.replace) history.replaceState(null, "", path);
	else history.pushState(null, "", path);
	window.dispatchEvent(new Event(changed));
	if (!options.replace) window.dispatchEvent(new Event(WENT));
}
