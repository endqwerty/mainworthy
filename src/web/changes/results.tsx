import { useInfiniteQuery } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { z } from "zod";
import { call } from "../lib/api.ts";
import { queryKey } from "../lib/data.ts";
import { navigate, refUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { EmptyState, SectionHeading } from "../ui/index.tsx";

/** How the gate counts a result, problems first: the order the server lists them in. */
export const STANDINGS = ["unexplained", "attributed", "excused", "missing", "skipped", "pass"] as const;
export type Standing = (typeof STANDINGS)[number];
export const STANDING_LABELS: Record<Standing, string> = {
	unexplained: "unexplained",
	attributed: "needs a fix",
	excused: "excused",
	missing: "could not run",
	skipped: "skipped",
	pass: "passed",
};
const isStanding = (key: string): key is Standing => STANDINGS.some((standing) => standing === key);
/** The tally key a gate counts a result under, when it is one a result can have. */
export const standingOf = (key: string): Standing | null => (isStanding(key) ? key : null);

export const Counted = z.object({
	result: z.number(),
	test: z.string(),
	name: z.string(),
	file: z.string().nullable(),
	case: z.string().nullable(),
	outcome: z.string(),
	standing: z.enum(STANDINGS),
	quarantined: z.boolean(),
	question: z.string().nullable(),
	attempt: z.number(),
	durationMs: z.number().nullable(),
	message: z.string().nullable(),
	job: z.string(),
	by: z.string(),
	build: z.string().nullable(),
});
type Counted = z.infer<typeof Counted>;

/** A report names its build's address, and only a web address is offered as a link. */
export const webUrl = (url: string | null): string | null => (url && /^https?:\/\//i.test(url) ? url : null);

export const duration = (ms: number | null): string | null =>
	ms === null ? null : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

/**
 * Every test the change's gate counted, as it counted it: the evidence behind the verdict. The filter is owned by
 * the screen, so the tally above can choose it too.
 */
export function ChangeResults({
	change,
	standing,
	choose,
}: {
	change: string;
	standing: Standing | null;
	choose: (standing: Standing | null) => void;
}) {
	const { project } = useApp();
	const [typed, setTyped] = useState("");
	const text = useDeferredValue(typed.trim());
	const input = {
		in: "results",
		change,
		limit: 100,
		...(standing ? { state: standing } : {}),
		...(text ? { text } : {}),
	} satisfies Parameters<typeof call<"find">>[1];
	const read = useInfiniteQuery({
		queryKey: [...queryKey({ project, op: "find", input }), "pages"],
		initialPageParam: "",
		queryFn: ({ pageParam, signal }) =>
			call("find", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }, { project, signal }),
		getNextPageParam: (page) => page.cursor ?? undefined,
	});
	const pages = read.data?.pages ?? [];
	const parsed = Counted.array().safeParse(pages.flatMap((page) => page.items));
	const rows = parsed.success ? parsed.data : [];
	const tally = pages[0]?.tally ?? {};
	const total = Object.values(tally).reduce((sum, n) => sum + n, 0);
	const matching = pages[0]?.count ?? 0;
	return (
		<>
			<SectionHeading>
				<span id="change-results">Results</span>
			</SectionHeading>
			<fieldset className="change-results-filter" aria-label="Show results">
				<button type="button" aria-pressed={standing === null} onClick={() => choose(null)}>
					All {total}
				</button>
				{STANDINGS.filter((key) => (tally[key] ?? 0) > 0).map((key) => (
					<button
						type="button"
						key={key}
						aria-pressed={standing === key}
						className={`s-${key}`}
						onClick={() => choose(standing === key ? null : key)}
					>
						{tally[key]} {STANDING_LABELS[key]}
					</button>
				))}
			</fieldset>
			{total > 0 && (
				<input
					className="change-results-text"
					type="search"
					aria-label="Filter results by test name or file"
					placeholder="Filter by test name or file"
					value={typed}
					onChange={(event) => setTyped(event.target.value)}
				/>
			)}
			{read.error && <p role="status">{read.error.message}</p>}
			{!parsed.success && <p role="status">The results could not be read.</p>}
			<ul className="change-results" aria-label="Results the gate counted">
				{rows.map((row) => (
					<ResultRow key={`${row.result}:${row.job}`} row={row} project={project} />
				))}
			</ul>
			{rows.length === 0 && !read.isPending && !read.error && (
				<EmptyState doc={{ page: "report-results", label: "How to send a report" }}>
					{total === 0 ? "No results counted for the latest commit." : "No result matches."}
				</EmptyState>
			)}
			{read.isFetchNextPageError ? (
				// The results changed since the first page, so the server refused the next one rather than skip or repeat
				// a row. Reading again starts from the first page.
				<button type="button" className="change-results-more" onClick={() => void read.refetch()}>
					Read the results again
				</button>
			) : (
				read.hasNextPage && (
					<button type="button" className="change-results-more" onClick={() => void read.fetchNextPage()}>
						Show more ({matching - rows.length} left)
					</button>
				)
			)}
		</>
	);
}

function ResultRow({ row, project }: { row: Counted; project: string }) {
	const go = (ref: string) => (event: { preventDefault: () => void }) => {
		event.preventDefault();
		navigate(refUrl({ project, ref }));
	};
	const facts = [
		row.file,
		row.job,
		row.attempt > 1 ? `attempt ${row.attempt}` : null,
		duration(row.durationMs),
		row.by,
	].filter((fact): fact is string => Boolean(fact));
	const build = webUrl(row.build);
	return (
		<li className={`change-result s-${row.standing}`}>
			<span className="result-standing">
				{row.quarantined ? "quarantined" : STANDING_LABELS[row.standing]}
				{row.outcome === "error" && " (error)"}
			</span>
			<span className="result-body">
				<a href={refUrl({ project, ref: row.test })} onClick={go(row.test)}>
					{row.name}
				</a>
				<small className="dim">{facts.join(" · ")}</small>
				{row.message && <small className="result-message">{row.message}</small>}
			</span>
			<span className="result-refs">
				{row.case && (
					<a className="ref" href={refUrl({ project, ref: row.case })} onClick={go(row.case)}>
						{row.case}
					</a>
				)}
				{row.question && (
					<a className="ref" href={refUrl({ project, ref: row.question })} onClick={go(row.question)}>
						{row.question}
					</a>
				)}
				{build && (
					<a href={build} target="_blank" rel="noreferrer noopener">
						build
					</a>
				)}
			</span>
		</li>
	);
}
