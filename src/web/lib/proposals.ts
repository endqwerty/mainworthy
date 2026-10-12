export function proposalReadMessage(q: string): string | null {
	const card = document.querySelector<HTMLElement>(
		`[data-proposal="${CSS.escape(q)}"], [data-proposal-evidence="${CSS.escape(q)}"]`,
	);
	if (card?.dataset.proposalRead === "ready") return null;
	return card?.dataset.proposalError || "Still reading the proposal. Read its edits before answering.";
}
