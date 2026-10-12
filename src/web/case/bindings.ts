import { useBindings } from "../lib/keys.ts";
export function useCaseBindings({
	enabled,
	diff,
	accept,
	reject,
}: {
	enabled: boolean;
	diff: () => void;
	accept: () => void;
	reject: () => void;
}): void {
	useBindings(
		[
			{ key: "v", label: "Version diff", handler: diff },
			{ key: "a", label: "Accept proposal", handler: accept },
			{ key: "r", label: "Reject proposal", handler: reject },
		].map((binding) => ({ ...binding, when: () => enabled })),
	);
}
