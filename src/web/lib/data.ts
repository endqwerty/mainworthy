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
const HIDDEN_STREAM_GRACE_MS = 60_000;
const VISIBLE_STREAM_IDLE_MS = 30 * 60_000;
type StreamLifecycle = "active" | "hidden-grace" | "hidden" | "idle" | "disposed";

/** One stream per active project. Focus/reconnect refetches repair every missed event. */
export function useEvents(project: string, setStatus: (text: string) => void): void {
	useEffect(() => {
		const owner = deviceSession();
		let lifecycle: StreamLifecycle = document.visibilityState === "hidden" ? "hidden" : "active";
		let pauseTimer: ReturnType<typeof setTimeout> | undefined;
		let connection = 0;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let events: EventSource | null = null;
		let announceReconnect = false;
		const eligible = () => lifecycle === "active" || lifecycle === "hidden-grace";
		function close(): void {
			connection++;
			clearTimeout(retry);
			clearTimeout(pauseTimer);
			events?.close();
			events = null;
		}
		function pause(reason: "hidden" | "idle"): void {
			lifecycle = reason;
			close();
			announceReconnect = true;
			setStatus("Live updates paused while this page is inactive.");
		}
		function armIdle(): void {
			clearTimeout(pauseTimer);
			pauseTimer = setTimeout(() => pause("idle"), VISIBLE_STREAM_IDLE_MS);
		}
		function activity(): void {
			if (document.visibilityState !== "visible") return;
			if (lifecycle === "idle") {
				lifecycle = "active";
				connect();
			}
			if (lifecycle === "active") armIdle();
		}
		function visibility(): void {
			if (document.visibilityState === "hidden") {
				if (lifecycle !== "active") return;
				lifecycle = "hidden-grace";
				clearTimeout(pauseTimer);
				pauseTimer = setTimeout(() => pause("hidden"), HIDDEN_STREAM_GRACE_MS);
			} else if (lifecycle === "hidden" || lifecycle === "hidden-grace") {
				const reopen = lifecycle === "hidden";
				lifecycle = "active";
				armIdle();
				if (reopen) connect();
			}
		}
		function connect(): void {
			if (!eligible() || !sessionCurrent(owner)) return;
			const stream = new EventSource(`/api/p/${encodeURIComponent(project)}/events`);
			events = stream;
			const attempt = ++connection;
			events.onerror = () => {
				if (!eligible() || events !== stream) return;
				stream.onerror = null;
				stream.close();
				events = null;
				announceReconnect = true;
				setStatus("Live updates disconnected. Checking the session and reconnecting…");
				void reconnect(attempt);
			};
			events.onmessage = (event) => {
				if (!eligible() || events !== stream) return;
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
				if (!eligible() || events !== stream) return;
				if (announceReconnect) {
					setStatus("Live updates reconnected.");
					announceReconnect = false;
				}
				void invalidateProject(project);
			};
		}
		async function reconnect(attempt: number): Promise<void> {
			const currentAttempt = () => eligible() && connection === attempt && sessionCurrent(owner);
			if (!currentAttempt()) return;
			try {
				const current = await session({ owner });
				if (!currentAttempt()) return;
				if (current.actorId !== owner.actorId) {
					suspendDeviceSession();
					window.dispatchEvent(new Event(unauthenticatedEvent));
					return;
				}
			} catch (error) {
				if (!currentAttempt()) return;
				if (error instanceof ApiError && error.code === "unauthenticated") {
					if (error.status === null) retry = setTimeout(() => void reconnect(attempt), 1000);
					return;
				}
			}
			retry = setTimeout(() => {
				if (currentAttempt()) connect();
			}, 1000);
		}
		document.addEventListener("visibilitychange", visibility);
		window.addEventListener("keydown", activity, true);
		window.addEventListener("pointerdown", activity, true);
		if (lifecycle === "active") {
			armIdle();
			connect();
		}
		return () => {
			lifecycle = "disposed";
			close();
			document.removeEventListener("visibilitychange", visibility);
			window.removeEventListener("keydown", activity, true);
			window.removeEventListener("pointerdown", activity, true);
		};
	}, [project, setStatus]);
}
