/**
 * Where a ceremony began, as one text that only the same place makes again. Each holds the SHA-256 of a secret
 * and never a row's number: an import gives a number to another row, and a hash goes with what it is of.
 */
export const CONTEXT = {
	/** A browser nobody is signed in on, known by the ceremony cookie set with the challenge: the cookie's hash. */
	browser: (cookieHash: string): string => `browser ${cookieHash}`,
	/** A signed-in browser's session: the hash of its session cookie, which is what its row stores. */
	session: (sessionHash: string): string => `session ${sessionHash}`,
	/** The owner of the machine in local mode, who has no session: every such request is that one person. */
	local: "local",
	/** An invitation: the hash of its code. */
	invitation: (codeHash: string): string => `invitation ${codeHash}`,
} as const;

export function sessionHash(context: string | null): string | null {
	return context?.startsWith("session ") ? context.slice(8) : null;
}
