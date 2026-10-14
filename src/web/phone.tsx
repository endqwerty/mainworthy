import { useCallback, useEffect, useState } from "react";
import { usePhone } from "./lib/layout.ts";
import { type Route, readRoute, WENT } from "./lib/router.ts";
import "./phone.css";

/** Which of a screen's two panes a phone shows. The desktop shows both and never reads this. */
export type Pane = "list" | "detail";

const typingIn = (pane: Pane): boolean => {
	const node = document.activeElement;
	return (
		node instanceof HTMLElement &&
		(node.matches("input, textarea, select") || node.isContentEditable) &&
		node.closest(`#${pane}`) !== null
	);
};

/**
 * What the shell keeps for a phone (decision 0018): the pane that fills the window, and whether the sidebar is
 * drawn over it. No screen takes part. The detail is shown when
 *
 * - a row of the list is pressed (every screen's list is a listbox of options),
 * - somebody goes to an address that names something: a link to a case, a question, a run or a change, the
 *   palette's jump to one, the browser's Back and Forward. An address that changes in place (`replace`) is
 *   nobody going anywhere, and the pane stays: a case that was recorded after Back gets its address so.
 * - anything in the detail takes the focus, as when an action of the palette opens the editor there.
 *
 * Both panes stay laid out, one over the other, so a pane that is covered can still take the focus.
 *
 * One rule holds all of it together: what is covered cannot be acted on. The pointer cannot reach it (the
 * stylesheet). What takes the focus is shown first, and what gets covered gives the focus up (here). A key or
 * the palette runs only the actions of the list while the detail is covered (`listOnly`; `Binding.list`). And
 * under the palette or the sheet of keys the whole app is inert (`app.tsx`).
 */
export function usePhoneShell(
	route: Route,
	/** The palette or the sheet of keys is open. The sidebar is not left open under it. */
	overlayOpen: boolean,
): {
	phone: boolean;
	pane: Pane;
	showList: () => void;
	menu: boolean;
	setMenu: (open: boolean) => void;
	/** The detail of the selected row is covered, by the list or by the sidebar: only an action of the list runs. */
	listOnly: boolean;
} {
	const phone = usePhone();
	const [pane, show] = useState<Pane>(route.ref ? "detail" : "list");
	// The sidebar is open at the address it was opened at. Going anywhere closes it.
	const address = location.pathname + location.search;
	const [menuAt, setMenuAt] = useState<string | null>(null);
	if (overlayOpen && menuAt !== null) setMenuAt(null);
	const menu = phone && menuAt === address;
	useEffect(() => {
		if (!phone) return;
		// Where the address points decides the pane when somebody goes there, and when a window that was laid
		// out for the desktop becomes a phone's (a tablet turned upright).
		const there = () => show(readRoute().ref ? "detail" : "list");
		// Going somewhere closes the sidebar, also when it is to the address the page is at.
		const went = () => {
			there();
			setMenuAt(null);
		};
		there();
		const pressed = (event: MouseEvent) => {
			if (event.target instanceof Element && event.target.closest("#list [role=option]")) show("detail");
		};
		// The Tab key moves the focus in the same task as its keydown, so the flag is still up when the focus
		// arrives and down again before anything else can move it.
		let tabbed = false;
		const key = (event: KeyboardEvent) => {
			if (event.key !== "Tab") return;
			tabbed = true;
			setTimeout(() => {
				tabbed = false;
			}, 0);
		};
		// What takes the focus is shown, and is not left under the sidebar. In the detail that is anything: a
		// field an action put the caret in, and a button the Tab key of an attached keyboard reached, before
		// Enter presses it. In the list it is a field, or what Tab reached. A screen that gives its list the
		// focus back after an answer or a result does neither, and the person stays on the detail.
		const focused = (event: FocusEvent) => {
			const node = event.target;
			if (!(node instanceof Element)) return;
			const to = node.closest("#detail")
				? "detail"
				: node.closest("#list") && (typingIn("list") || tabbed)
					? "list"
					: null;
			if (to === null) return;
			show(to);
			setMenuAt(null);
		};
		// Something that is in the sidebar asks to be seen: the form of a new folder.
		const sidebar = () => setMenuAt(location.pathname + location.search);
		window.addEventListener("mainworthy:sidebar", sidebar);
		window.addEventListener(WENT, went);
		window.addEventListener("popstate", went);
		window.addEventListener("click", pressed);
		window.addEventListener("keydown", key, true);
		window.addEventListener("focusin", focused);
		return () => {
			window.removeEventListener("mainworthy:sidebar", sidebar);
			window.removeEventListener(WENT, went);
			window.removeEventListener("popstate", went);
			window.removeEventListener("click", pressed);
			window.removeEventListener("keydown", key, true);
			window.removeEventListener("focusin", focused);
		};
	}, [phone]);
	// What gets covered gives the focus up: text typed, or Enter pressed, would go to something nobody sees.
	// The detail is covered by the list, and both panes by the sidebar.
	useEffect(() => {
		if (!phone) return;
		const node = document.activeElement;
		if (!(node instanceof HTMLElement)) return;
		if (node.closest(menu ? "#list, #detail" : pane === "list" ? "#detail" : "#none")) node.blur();
	}, [phone, menu, pane]);
	return {
		phone,
		pane,
		showList: useCallback(() => {
			// Back leaves what was open, as going to another address does: an editor records what was typed
			// (`mainworthy:leave`, which `navigate` sends too), and nothing stays open under the list.
			window.dispatchEvent(new Event("mainworthy:leave"));
			show("list");
		}, []),
		menu,
		setMenu: useCallback((open: boolean) => setMenuAt(open ? location.pathname + location.search : null), []),
		listOnly: phone && (pane === "list" || menu),
	};
}

/** The bar a phone has where the desktop has the sidebar: the way to the sidebar, back to the list, and to the actions. */
export function PhoneBar({
	title,
	pane,
	menu,
	onMenu,
	onBack,
	onActions,
}: {
	title: string;
	pane: Pane;
	menu: boolean;
	onMenu: () => void;
	onBack: () => void;
	onActions: () => void;
}) {
	return (
		<header id="top" className="phone-bar">
			<button type="button" className="top-menu" aria-label="Menu" aria-expanded={menu} onClick={onMenu}>
				☰
			</button>
			{pane === "detail" && (
				<button type="button" className="top-back" aria-label="Back to the list" onClick={onBack}>
					‹ Back
				</button>
			)}
			<b>{title}</b>
			<button type="button" className="top-actions" onClick={onActions}>
				Actions
			</button>
		</header>
	);
}
