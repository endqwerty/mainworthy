import { createContext, useContext } from "react";
import type { SessionInfo } from "../../core/api.ts";
import type { Route } from "../lib/router.ts";
/** `current` marks what is already so (the project that is open): it is shown, and the choice starts past it. */
export type PaletteItem = { id: string; label: string; detail?: string; current?: boolean; handler: () => void };
export type PaletteOptions = { title?: string; items?: PaletteItem[]; onPickCase?: (ref: string) => void };
export type AppContext = {
	project: string;
	route: Route;
	session: SessionInfo;
	instanceCan: readonly string[];
	/** The status line. A function gets the line as it is now, for a message that replaces only its own. */
	setStatus: (text: string | ((shown: string) => string)) => void;
	openPalette: (options?: PaletteOptions) => void;
	refreshSession: () => Promise<void>;
	overlayOpen: boolean;
};
export const AppContext = createContext<AppContext | null>(null);
export function useApp(): AppContext {
	const value = useContext(AppContext);
	if (!value) throw new Error("A screen must be inside the Mainworthy app");
	return value;
}
