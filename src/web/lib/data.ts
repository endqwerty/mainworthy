import { type Query, QueryClient, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Api, OpName } from "../../core/api.ts";
import { ApiError, call, session, unauthenticatedEvent } from "./api.ts";
import { deviceSession, sessionCurrent, suspendDeviceSession } from "./device.ts";
import { affected, Change } from "./refresh.ts";

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
 * On events, every in-flight read finishes before its one pending refresh, so a flood cannot keep cancelling it.
 * Explicit refreshes replace active ordinary reads with data: callers may have just held a newer cached reply.
 * First reads need the trailing read too: their reply may precede the event on the server (issue #87).
 * Yield after each reply so automatic paging can start its next page before refreshing the loaded pages.
 */
async function readAgain(stale: (query: Query) => boolean, replace = false): Promise<void> {
	// Proposal cursors belong to one project snapshot. Its next page is obsolete as soon as a write is known.
	const snapshots = queryClient.getQueryCache().findAll({
		predicate: (query) => stale(query) && query.meta?.restartOnChange === true && query.state.fetchStatus !== "idle",
	});
	if (snapshots.length) {
		for (const query of snapshots) askedAgain.delete(query);
		await Promise.all(snapshots.map((query) => queryClient.cancelQueries({ queryKey: query.queryKey, exact: true })));
	}
	const replaces = (query: Query): boolean =>
		replace && query.isActive() && query.state.data !== undefined && query.queryKey[3] !== "pages";
	for (const query of askedAgain.keys()) if (stale(query) && replaces(query)) askedAgain.delete(query);
	const loading = queryClient.getQueryCache().findAll({
		predicate: (query) => stale(query) && !replaces(query) && query.state.fetchStatus !== "idle",
	});
	for (const query of loading) {
		const reading = query.promise;
		if (askedAgain.has(query) || !reading) continue;
		const again = async (): Promise<void> => {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			if (askedAgain.get(query) !== refresh) return;
			askedAgain.delete(query);
			if (queryClient.getQueryCache().get(query.queryHash) === query) await readAgain((current) => current === query);
		};
		const refresh = reading.then(again, again);
		askedAgain.set(query, refresh);
	}
	const waiting = [...askedAgain].filter(([query]) => stale(query)).map(([, read]) => read);
	return Promise.all([
		...waiting,
		queryClient.invalidateQueries({ predicate: (query) => stale(query) && !askedAgain.has(query) }),
	]).then(() => {});
}
export function invalidateProject(project: string): Promise<void> {
	return readAgain((query) => query.queryKey[0] === project, true);
}
const pending = new Set<Query>();
/** Merges calls within one task. Separate SSE messages merge while a read is in flight and owe one trailing read. */
export function changed(project: string, change: Parameters<typeof affected>[1]): void {
	const scheduled = pending.size > 0;
	for (const query of queryClient.getQueryCache().findAll())
		if (query.queryKey[0] === project && (query.meta?.restartOnChange === true || affected(query.queryKey, change)))
			pending.add(query);
	if (scheduled || pending.size === 0) return;
	queueMicrotask(() => {
		const queries = new Set(pending);
		pending.clear();
		void readAgain((query) => queries.has(query));
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
				if (disposed || !sessionCurrent(owner)) return;
				if (error instanceof ApiError && error.code === "unauthenticated") {
					if (error.status === null) retry = setTimeout(() => void reconnect(), 1000);
					return;
				}
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
