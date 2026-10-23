/** Neutralize both Actions command syntaxes, including the legacy prefix matched anywhere in a line. */
export function escapeWorkflowCommands(text: string): string {
	return text.replace(/^([^\S\n]*)::/gm, "$1\\u003a:").replaceAll("##[", "\\u0023#[");
}
