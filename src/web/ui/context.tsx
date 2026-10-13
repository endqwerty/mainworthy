import { createContext, useContext } from "react";
import type { SessionInfo } from "../../core/api.ts";
import type { Route } from "../lib/router.ts";
export type PaletteItem = { id: string; label: string; detail?: string; handler: () => void };
export type PaletteOptions = { title?: string; items?: PaletteItem[]; onPickCase?: (ref: string) => void };
export type AppContext = {
	project: string;
	route: Route;
	session: SessionInfo;
	instanceCan: readonly string[];
	setStatus: (text: string) => void;
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
