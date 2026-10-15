import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../lib/api.ts";
import { NO_ANSWER } from "../lib/signin.ts";
import { useApp } from "../ui/context.tsx";

/**
 * A list about signing in: sessions, credentials, invitations. It is read again every time its section is
 * opened, however lately it was read. Another browser may have signed in or out meanwhile, and a list that is
 * a quarter of a minute old would show a session that is gone, with a button to end it.
 *
 * The key starts with the project, as every query's does, so that what the app does to a project's queries
 * (read them again on focus, drop them when the person changes) reaches these too.
 */
export function useList<Row>(name: string, read: (options: { signal: AbortSignal }) => Promise<Row[]>, actor?: string) {
	const { project } = useApp();
	return useQuery({
		queryKey: [project, name, { do: "list", ...(actor === undefined ? {} : { actor }) }],
		queryFn: ({ signal }) => read({ signal }),
		refetchOnMount: "always",
	});
}

/** What to show for a failed request: the server's own words when it refused, else that it did not answer. */
export const saidBy = (error: unknown): string => (error instanceof ApiError ? error.message : NO_ANSWER);

/**
 * What to show when something that changes the instance failed. A refusal is the server's own words. With no
 * reply at all the request may still have arrived and been done, so "try again" would be wrong: `ifLost` says
 * what may have happened and how to find out.
 */
export const saidOfWrite = (error: unknown, ifLost: string): string =>
	error instanceof ApiError ? error.message : ifLost;

/** A set of the rows a request is under way for, with one more or one fewer. */
export const withId = (ids: ReadonlySet<number>, id: number, present: boolean): Set<number> => {
	const next = new Set(ids);
	if (present) next.add(id);
	else next.delete(id);
	return next;
};
