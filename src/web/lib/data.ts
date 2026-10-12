import { QueryClient, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { z } from "zod";
import type { Api, OpName } from "../../core/api.ts";
import { call } from "./api.ts";

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
export function invalidateProject(project: string): Promise<void> {
	return queryClient.invalidateQueries({ queryKey: [project] });
}
const Change = z.object({ op: z.string().optional(), touched: z.array(z.string()) });
/** One stream per active project. Focus/reconnect refetches repair every missed event. */
export function useEvents(project: string): void {
	useEffect(() => {
		const events = new EventSource(`/api/p/${encodeURIComponent(project)}/events`);
		events.onmessage = (event) => {
			let raw: unknown;
			try {
				raw = JSON.parse(event.data);
			} catch {
				return;
			}
			const parsed = Change.safeParse(raw);
			if (!parsed.success) return;
			const refs = parsed.data.touched;
			void queryClient.invalidateQueries({
				predicate: (query) => {
					if (query.queryKey[0] !== project) return false;
					const op = query.queryKey[1];
					if (op === "find" || op === "inbox" || op === "gate" || op === "impact" || op === "admin") return true;
					// A proposal's event names its proposal and question, so an open case's timeline must be read again.
					if (op === "timeline" && parsed.data.op === "propose") return true;
					const input = JSON.stringify(query.queryKey[2]) ?? "";
					return (
						refs.length === 0 || refs.some((ref) => input.includes(ref)) || refs.some((ref) => !/^[CQRPT]-/.test(ref))
					);
				},
			});
		};
		events.onopen = () => {
			void invalidateProject(project);
		};
		return () => events.close();
	}, [project]);
}
/** Optimistic cache changes roll back on failure; the caller keeps its input outside the cache. */
export async function optimisticWrite<T>({
	key,
	update,
	write,
}: {
	key: readonly unknown[];
	update: (previous: T | undefined) => T;
	write: () => Promise<unknown>;
}): Promise<void> {
	await queryClient.cancelQueries({ queryKey: key });
	const previous = queryClient.getQueryData<T>(key);
	queryClient.setQueryData<T>(key, update(previous));
	try {
		await write();
	} catch (error) {
		queryClient.setQueryData(key, previous);
		throw error;
	} finally {
		void queryClient.invalidateQueries({ queryKey: key });
	}
}
