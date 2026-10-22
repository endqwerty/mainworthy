import { useBindings } from "../lib/keys.ts";
export function useCaseBindings({
	enabled,
	canAccept,
	canReject,
	diff,
	accept,
	reject,
}: {
	enabled: boolean;
	canAccept: boolean;
	canReject: boolean;
	diff: () => void;
	accept: () => void;
	reject: () => void;
}): void {
	useBindings([
		{ key: "v", label: "Version diff", handler: diff, applies: () => enabled },
		{ key: "a", label: "Accept proposal", handler: accept, applies: () => enabled && canAccept },
		{ key: "r", label: "Reject proposal", handler: reject, applies: () => enabled && canReject },
	]);
}
