/** Let the shell reveal a covered pane before the browser attempts to focus an inert descendant. */
export function focusInto(node: HTMLElement | null | undefined): void {
	if (!node) return;
	window.dispatchEvent(new CustomEvent("mainworthy:focus", { detail: node }));
	node.focus();
}
