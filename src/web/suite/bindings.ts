import { useBindings } from "../lib/keys.ts";

const action = (key: string, label: string, handler: () => void, hidden = false) => ({ key, label, handler, hidden });
export function useSuiteBindings({
	create,
	edit,
	next,
	previous,
	filter,
	seal,
	select,
	move,
	tag,
	removeTag,
	archive,
	restoring,
	undo,
	peek,
	folder,
	newFolder,
	zoom,
	cancelTag,
	cancelFolder,
}: {
	create: () => void;
	edit: () => void;
	next: () => void;
	previous: () => void;
	filter: () => void;
	seal: () => void;
	select: () => void;
	move: () => void;
	tag: () => void;
	removeTag: () => void;
	archive: () => void;
	restoring: boolean | null;
	undo: () => void;
	peek: () => void;
	folder: (direction: number) => void;
	newFolder: () => void;
	zoom: () => void;
	/** Closes the open form, or null while it is closed. */
	cancelTag: (() => void) | null;
	cancelFolder: (() => void) | null;
}): void {
	// The tag and folder forms close with Escape, which a phone has no key for: while one is open, the palette lists
	// what Escape does there (decision 0018), and runs it when chosen. Escape in the form's field is the field's own.
	// The keyboard handler pauses screen keys under overlays. In the case editor, Escape leaves the editor.
	const cancelling = () =>
		!(document.activeElement instanceof Element && document.activeElement.closest(".body-editor"));
	useBindings([
		// The three marked `list` do not act on the case the detail shows (`Binding.list`).
		{ key: "c", label: "New case", list: true, handler: create },
		action("e", "Edit case", edit),
		action("enter", "Edit case", edit),
		action("j", "Next case", next),
		action("arrowdown", "Next case", next, true),
		action("k", "Previous case", previous),
		action("arrowup", "Previous case", previous, true),
		{ key: "/", label: "Filter", list: true, handler: filter },
		action("escape", "Seal and leave editor", seal),
		action("mod+enter", "Record version", seal),
		action("shift+enter", "Next new case", create),
		action("x", "Select case", select),
		action("m", "Move selected", move),
		action("t", "Tag selected", tag),
		action("alt+t", "Remove tag from selected cases", removeTag),
		action(
			"#",
			restoring === null ? "Archive/restore unavailable" : restoring ? "Restore selected" : "Archive selected",
			archive,
		),
		action("u", "Undo", undo),
		action("space", "Peek timeline", peek),
		action("alt+[", "Previous folder", () => folder(-1)),
		action("]", "Next folder", () => folder(1)),
		// Its form is in the sidebar, which a phone keeps closed: the shell opens it (`mainworthy:sidebar`). It
		// makes a folder and decides nothing about a case, so a phone offers it over the list too.
		{
			key: "n f",
			label: "New folder",
			list: true,
			handler: () => {
				newFolder();
				window.dispatchEvent(new Event("mainworthy:sidebar"));
			},
		},
		action("z", "Widen case pane", zoom),
		...(cancelTag ? [{ key: "escape", label: "Cancel tag", list: true, handler: cancelTag, applies: cancelling }] : []),
		...(cancelFolder
			? [{ key: "escape", label: "Cancel new folder", list: true, handler: cancelFolder, applies: cancelling }]
			: []),
	]);
}
