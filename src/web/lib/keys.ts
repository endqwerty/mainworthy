import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

export type Binding = {
	key: string;
	label: string;
	handler: () => void;
	when?: () => boolean;
	allowInInput?: boolean;
	hidden?: boolean;
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
		items.map(({ key, label, hidden, when }) => ({ key, label, hidden, available: !when || when() })),
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
	const key = event.key === " " ? "space" : event.key.toLowerCase();
	return `${event.ctrlKey || event.metaKey ? "mod+" : ""}${event.altKey ? "alt+" : ""}${event.shiftKey && key.length > 1 ? "shift+" : ""}${key}`;
}
export function useKeyboard(): void {
	useEffect(() => {
		const openingKeys = new Set<string>();
		const release = (event: KeyboardEvent) => openingKeys.delete(event.code);
		const suppress = (event: KeyboardEvent) => {
			if (event.repeat && openingKeys.has(event.code)) {
				event.preventDefault();
				event.stopImmediatePropagation();
			}
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
			// screens' own use of the keys: a control that was clicked holds the focus without showing it
			// (`:focus-visible`), so the next Enter is still the screen's; and the rows of a screen's list are
			// the screen's to act on, whichever of them has the focus.
			if (
				(key === "enter" || key === "space") &&
				target instanceof HTMLElement &&
				target.matches("button, a[href], summary") &&
				target.matches(":focus-visible") &&
				target.closest("#list") === null
			) {
				// A key held down presses once, as it does where a screen's binding takes it.
				if (event.repeat) event.preventDefault();
				chord = "";
				return;
			}
			const candidates = bindings().filter(
				(binding) =>
					(!binding.when || binding.when()) &&
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
		return () => {
			window.removeEventListener("keydown", suppress, true);
			window.removeEventListener("keyup", release, true);
			window.removeEventListener("keydown", handle);
		};
	}, []);
}
