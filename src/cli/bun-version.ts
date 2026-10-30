// The oldest Bun that Mainworthy runs on, asked by the command line before it does anything and by the checks before
// a test runs (`scripts/preflight.ts`). This file imports nothing: the preflight runs where nothing is installed.

/**
 * Bun 1.4.4 is the first whose `query.cancel()` reaches PostgreSQL: on 1.4.3 it sends nothing for a statement already
 * sent, so a stopped request's statement would run on, and a stopping server would wait for it (#1115).
 */
export const OLDEST_BUN = "1.4.4";

/** Why this Bun cannot run Mainworthy, or null when it can. */
export function bunTooOld(version: string, bun: string): string | null {
	if (Bun.semver.satisfies(version, `>=${OLDEST_BUN}`)) return null;
	return `this is Bun ${version} (${bun}) and Mainworthy needs Bun ${OLDEST_BUN} or newer. Put a newer one first on PATH (\`which -a bun\` lists the ones this machine has) or run \`bun upgrade\`.`;
}
