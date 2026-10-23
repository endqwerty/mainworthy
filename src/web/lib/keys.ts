import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

export type Binding = {
	key: string;
	label: string;
	handler: () => void;
	applies?: () => boolean;
	/** The shell's palette toggle and close keys still work while an overlay pauses screen keys. */
	allowInOverlay?: boolean;
	allowInInput?: boolean;
	hidden?: boolean;
	/**
	 * A phone's palette does not list it: it opens the palette or the sheet of keys, which a finger reaches by
	 * a button, and a sheet of keys is no use without a keyboard. The key still works where there is one.
	 */
	desktopOnly?: boolean;
	/**
	 * An action of the list: it runs on a phone while the list is shown, from the palette and from a key of a
	 * keyboard attached to it. Every other action runs there only while the detail is shown, because it may act
	 * on what the detail shows (an answer, a result, an accepted proposal) and nobody decides about what they
	 * cannot see. The desktop shows both panes, so this changes nothing there.
	 */
	list?: boolean;
};
const groups = new Map<string, { current: Binding[] }>();
const listeners = new Set<() => void>();
let revision = 0;
let chord = "";
let chordAt = 0;
function notify(): void {
	revision++;
	for (const listener of listeners) listener();
}
export function bindings(): Binding[] {
	return [...groups.values()].flatMap((group) => group.current);
}
export function useBindings(items: Binding[]): void {
	const id = useId();
	const latest = useRef(items);
	latest.current = items;
	const signature = JSON.stringify(
		items.map(({ key, label, hidden, applies }) => ({ key, label, hidden, available: !applies || applies() })),
	);
	useEffect(() => {
		groups.set(id, latest);
		notify();
		return () => {
			groups.delete(id);
			notify();
		};
	}, [id]);
	const previous = useRef(signature);
	useEffect(() => {
		if (previous.current !== signature) {
			previous.current = signature;
			notify();
		}
	}, [signature]);
}
export function useKeyRegistry(): Binding[] {
	useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		() => revision,
	);
	return bindings();
}
function keyOf(event: KeyboardEvent): string {
	let value = event.key;
	if (event.altKey && !/^[a-z0-9[\]]$/i.test(event.key)) {
		if (/^(Key[A-Z]|Digit[0-9])$/.test(event.code)) value = event.code.replace(/^(Key|Digit)/, "");
		else if (event.code === "BracketLeft") value = "[";
		else if (event.code === "BracketRight") value = "]";
	}
	const key = value === " " ? "space" : value.toLowerCase();
	return `${event.ctrlKey || event.metaKey ? "mod+" : ""}${event.altKey ? "alt+" : ""}${event.shiftKey && key.length > 1 ? "shift+" : ""}${key}`;
}
/** `listOnly`: a phone that shows the list. Then a key runs an action of the list and no other (`Binding.list`). */
export function useKeyboard(options: { listOnly: boolean; overlayOpen: boolean }): void {
	const latest = useRef(options);
	latest.current = options;
	useEffect(() => {
		const openingKeys = new Set<string>();
		const release = (event: KeyboardEvent) => openingKeys.delete(event.code);
		const suppress = (event: KeyboardEvent) => {
			if (event.repeat && openingKeys.has(event.code)) {
				event.preventDefault();
				event.stopImmediatePropagation();
			}
		};
		// The control the pointer gave the focus to, until the focus goes elsewhere. `:focus-visible` cannot say
		// this: a browser starts matching it on a clicked button the moment a key arrives, before `handle` runs.
		let clicked: Element | null = null;
		const pointed = (event: PointerEvent) => {
			clicked = event.target instanceof Element ? event.target.closest("button, a[href], summary") : null;
		};
		const focused = (event: FocusEvent) => {
			if (event.target !== clicked) clicked = null;
		};
		// Tab moves the focus by keyboard, also back to a control that was clicked a moment ago and, in a browser
		// that gives a clicked button no focus, to one that was clicked and never focused.
		const tabbed = (event: KeyboardEvent) => {
			if (event.key === "Tab") clicked = null;
		};
		const handle = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.isComposing ||
				event.key === "Shift" ||
				event.key === "Meta" ||
				event.key === "Control"
			)
				return;
			const key = keyOf(event);
			const target = event.target;
			const input =
				target instanceof HTMLElement && (target.matches("input,textarea,select") || target.isContentEditable);
			const inOverlay = target instanceof HTMLElement && target.closest("[data-overlay]") !== null;
			// Enter and Space are a focused control's own keys: they press the button or follow the link that
			// shows the focus. A screen's binding on either key does not take them from it, or a button reached
			// with Tab could not be pressed at all (Sign out on the Suite, 2026-10-13). Two things keep the
			// screens' own use of the keys: a control the pointer gave the focus to (`clicked`) leaves the next
			// Enter to the screen, as it did before; and the rows of a screen's list (every row is an `option`) are
			// the screen's to act on, whichever of them has the focus. A button beside the rows is a button.
			if (
				(key === "enter" || key === "space") &&
				target instanceof HTMLElement &&
				target.matches("button, a[href], summary") &&
				target !== clicked &&
				target.closest("[role=option]") === null
			) {
				// A key held down presses once, as it does where a screen's binding takes it.
				if (event.repeat) event.preventDefault();
				chord = "";
				return;
			}
			const candidates = bindings().filter(
				(binding) =>
					(!binding.applies || binding.applies()) &&
					(!latest.current.overlayOpen || binding.allowInOverlay) &&
					(!latest.current.listOnly || binding.list) &&
					(!input || key.startsWith("mod+") || key === "escape" || binding.allowInInput) &&
					(!inOverlay || key === "escape" || key === "mod+k"),
			);
			const prefix = performance.now() - chordAt < 900 ? chord : "";
			const wanted = prefix ? `${prefix} ${key}` : key;
			const binding =
				[...candidates].reverse().find((item) => item.key.toLowerCase() === wanted) ??
				[...candidates].reverse().find((item) => item.key.toLowerCase() === key);
			if (binding) {
				event.preventDefault();
				chord = "";
				if (event.repeat && !["j", "k", "arrowdown", "arrowup", "arrowleft", "arrowright"].includes(key)) return;
				const before = document.activeElement;
				flushSync(binding.handler);
				const after = document.activeElement;
				if (
					after !== before &&
					after instanceof HTMLElement &&
					(after.matches("input,textarea") || after.isContentEditable)
				)
					openingKeys.add(event.code);
				return;
			}
			if (
				event.repeat &&
				(key === "enter" || key === "space") &&
				target instanceof HTMLElement &&
				target.closest("button,form")
			) {
				event.preventDefault();
				return;
			}
			if (candidates.some((item) => item.key.toLowerCase().startsWith(`${key} `))) {
				event.preventDefault();
				chord = key;
				chordAt = performance.now();
			} else chord = "";
		};
		window.addEventListener("keydown", suppress, true);
		window.addEventListener("keyup", release, true);
		window.addEventListener("keydown", handle);
		window.addEventListener("pointerdown", pointed, true);
		window.addEventListener("focusin", focused, true);
		window.addEventListener("keydown", tabbed, true);
		return () => {
			window.removeEventListener("keydown", tabbed, true);
			window.removeEventListener("pointerdown", pointed, true);
			window.removeEventListener("focusin", focused, true);
			window.removeEventListener("keydown", suppress, true);
			window.removeEventListener("keyup", release, true);
			window.removeEventListener("keydown", handle);
		};
	}, []);
}
