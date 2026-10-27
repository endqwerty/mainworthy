import { createContext, useContext } from "react";
import type { SessionInfo } from "../../core/api.ts";
import type { Route } from "../lib/router.ts";
/** `current` marks what is already so (the project that is open): it is shown, and the choice starts past it. */
export type PaletteItem = { id: string; label: string; detail?: string; current?: boolean; handler: () => void };
/** One write to the status line, told apart from every other write. */
export type StatusMark = symbol;
export type PaletteOptions = { title?: string; items?: PaletteItem[]; onPickCase?: (ref: string) => void };
export type AppContext = {
	project: string;
	route: Route;
	session: SessionInfo;
	instanceCan: readonly string[];
	/**
	 * The status line. A function gets the line as it is now, for a message that replaces only its own. Returns the
	 * mark of what the line holds afterwards: each write that changes it makes a new one, even with the same words.
	 */
	setStatus: (text: string | ((shown: string) => string)) => StatusMark;
	/**
	 * The answer to a status written earlier: it replaces the line while the line still holds that write. Once
	 * something newer is there, the answer goes to the notice under the line, which holds one answer at a time.
	 */
	settleStatus: (mark: StatusMark, text: string) => void;
	openPalette: (options?: PaletteOptions) => void;
	refreshSession: () => Promise<void>;
	requestSignOut: () => void;
};
export const AppContext = createContext<AppContext | null>(null);
export function useApp(): AppContext {
	const value = useContext(AppContext);
	if (!value) throw new Error("A screen must be inside the Mainworthy app");
	return value;
}
