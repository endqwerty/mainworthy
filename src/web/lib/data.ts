import { type Query, QueryClient, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { z } from "zod";
import type { Api, OpName } from "../../core/api.ts";
import { ApiError, call, session, unauthenticatedEvent } from "./api.ts";
import { deviceSession, sessionCurrent, suspendDeviceSession } from "./device.ts";

export const queryClient = new QueryClient({
	defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: true, refetchOnReconnect: true } },
});
export const queryKey = <O extends OpName>({
	project,
	op,
	input,
}: {
	project: string;
	op: O;
	input: Api[O]["input"];
}) => [project, op, input];
export function useQueryOp<O extends OpName>({
	project,
	op,
	input,
	enabled = true,
}: {
	project: string;
	op: O;
	input: Api[O]["input"];
	enabled?: boolean;
}) {
	return useQuery({
		queryKey: queryKey({ project, op, input }),
		queryFn: ({ signal }) => call(op, input, { project, signal }),
		enabled,
		placeholderData: (previous) => previous,
	});
}
const askedAgain = new Map<Query, Promise<void>>();
/**
 * Reads again what `stale` says a change on the server may have made out of date.
 *
 * A read that already has an answer is dropped if it is on its way and asked afresh. A first read is not: the
 * query client hands back the read that is on its way (`Query.fetch` drops one only for a query that has data),
 * and the reply, which the server may have read before the change, then counts as current for `staleTime`. On
 * 2026-10-13 a question settled elsewhere 10 ms after the queue first asked for it stayed "open" on the page
 * (issue #87). So a first read on its way is asked once more when it lands. It is not dropped instead: under a
 * stream of changes a first read that is dropped at each one would never show anything. Paged reads also
 * finish before being asked again, including a refresh of pages already loaded. Yield after each reply so a
 * screen can ask for its next page first; carry the one pending refresh across those reads until they finish.
 */
function readAgain(stale: (query: Query) => boolean): Promise<void> {
	const loading = queryClient.getQueryCache().findAll({
		predicate: (query) =>
			stale(query) &&
			query.state.fetchStatus !== "idle" &&
			(query.state.data === undefined || query.queryKey[3] === "pages"),
	});
	for (const query of loading) {
		const reading = query.promise;
		if (askedAgain.has(query) || !reading) continue;
		const again = async (): Promise<void> => {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			askedAgain.delete(query);
			await readAgain((current) => current === query);
		};
		askedAgain.set(query, reading.then(again, again));
	}
	const waiting = [...askedAgain].filter(([query]) => stale(query)).map(([, read]) => read);
	return Promise.all([
		...waiting,
		queryClient.invalidateQueries({ predicate: (query) => stale(query) && !askedAgain.has(query) }),
	]).then(() => {});
}
export function invalidateProject(project: string): Promise<void> {
	return readAgain((query) => query.queryKey[0] === project);
}
const Change = z.object({ op: z.string().optional(), touched: z.array(z.string()) });
/** Reads again what a change on the server, as the event stream tells it, may have made out of date. */
export function changed(project: string, change: z.infer<typeof Change>): void {
	const refs = change.touched;
	void readAgain((query) => {
		if (query.queryKey[0] !== project) return false;
		const op = query.queryKey[1];
		// A report (`stats`) counts across the whole project, so any change can move it.
		if (op === "find" || op === "inbox" || op === "gate" || op === "impact" || op === "admin" || op === "stats")
			return true;
		// A proposal's event names its proposal and question, so an open case's timeline must be read again.
		if (
			(op === "timeline" && change.op === "propose") ||
			((op === "get" || op === "timeline") && change.op === "report")
		)
			return true;
		const input = JSON.stringify(query.queryKey[2]) ?? "";
		// A proposal is read as accepting it would leave its cases now, so a change to a case can change it.
		if (op === "get" && input.includes('"P-') && refs.some((ref) => ref.startsWith("C-"))) return true;
		return refs.length === 0 || refs.some((ref) => input.includes(ref)) || refs.some((ref) => !/^[CQRPT]-/.test(ref));
	});
}
/** One stream per active project. Focus/reconnect refetches repair every missed event. */
export function useEvents(project: string, setStatus: (text: string) => void): void {
	useEffect(() => {
		const owner = deviceSession();
		let disposed = false;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let events: EventSource | null = null;
		let interrupted = false;
		function connect(): void {
			if (disposed || !sessionCurrent(owner)) return;
			const stream = new EventSource(`/api/p/${encodeURIComponent(project)}/events`);
			events = stream;
			events.onerror = () => {
				if (disposed || events !== stream) return;
				stream.onerror = null;
				stream.close();
				interrupted = true;
				setStatus("Live updates disconnected. Checking the session and reconnecting…");
				void reconnect();
			};
			events.onmessage = (event) => {
				let raw: unknown;
				try {
					raw = JSON.parse(event.data);
				} catch {
					return;
				}
				const parsed = Change.safeParse(raw);
				if (parsed.success) changed(project, parsed.data);
			};
			events.onopen = () => {
				if (interrupted) {
					setStatus("Live updates reconnected.");
					interrupted = false;
				}
				void invalidateProject(project);
			};
		}
		async function reconnect(): Promise<void> {
			try {
				const current = await session({ owner });
				if (disposed || !sessionCurrent(owner)) return;
				if (current.actorId !== owner.actorId) {
					suspendDeviceSession();
					window.dispatchEvent(new Event(unauthenticatedEvent));
					return;
				}
			} catch (error) {
				if (disposed || !sessionCurrent(owner) || (error instanceof ApiError && error.code === "unauthenticated"))
					return;
			}
			retry = setTimeout(connect, 1000);
		}
		connect();
		return () => {
			disposed = true;
			clearTimeout(retry);
			events?.close();
		};
	}, [project, setStatus]);
}
