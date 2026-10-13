import { useBindings } from "../lib/keys.ts";
export function useSuiteBindings({
	enabled,
	create,
	edit,
	next,
	previous,
	filter,
	seal,
	rapid,
	select,
	move,
	tag,
	archive,
	undo,
	peek,
	folder,
	newFolder,
	zoom,
}: {
	enabled: boolean;
	create: () => void;
	edit: () => void;
	next: () => void;
	previous: () => void;
	filter: () => void;
	seal: () => void;
	rapid: () => void;
	select: () => void;
	move: () => void;
	tag: () => void;
	archive: () => void;
	undo: () => void;
	peek: () => void;
	folder: (direction: number) => void;
	newFolder: () => void;
	zoom: () => void;
}): void {
	useBindings(
		[
			// The two marked `list` do not act on the case the detail shows (`Binding.list`).
			{ key: "c", label: "New case", list: true, handler: create },
			{ key: "e", label: "Edit case", handler: edit },
			{ key: "enter", label: "Edit case", handler: edit },
			{ key: "j", label: "Next case", handler: next },
			{ key: "arrowdown", label: "Next case", handler: next, hidden: true },
			{ key: "k", label: "Previous case", handler: previous },
			{ key: "arrowup", label: "Previous case", handler: previous, hidden: true },
			{ key: "/", label: "Filter", list: true, handler: filter },
			{ key: "escape", label: "Seal and leave editor", handler: seal },
			{ key: "mod+enter", label: "Record version", handler: seal },
			{ key: "shift+enter", label: "Next new case", handler: rapid },
			{ key: "x", label: "Select case", handler: select },
			{ key: "m", label: "Move selected", handler: move },
			{ key: "t", label: "Tag selected", handler: tag },
			{ key: "#", label: "Archive selected", handler: archive },
			{ key: "u", label: "Undo", handler: undo },
			{ key: "space", label: "Peek timeline", handler: peek },
			{ key: "alt+[", label: "Previous folder", handler: () => folder(-1) },
			{ key: "]", label: "Next folder", handler: () => folder(1) },
			{ key: "n f", label: "New folder", handler: newFolder },
			{ key: "z", label: "Widen case pane", handler: zoom },
		].map((binding) => ({ ...binding, when: () => enabled })),
	);
}
