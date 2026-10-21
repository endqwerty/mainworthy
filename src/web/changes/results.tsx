import { useInfiniteQuery } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { z } from "zod";
import { ResultTrail as TrailSchema } from "../../core/results.ts";
import { isResultStanding, RESULT_STANDING_LABELS, RESULT_STANDINGS, type ResultStanding } from "../../core/runs.ts";
import { call } from "../lib/api.ts";
import { queryKey } from "../lib/data.ts";
import { navigate, refUrl } from "../lib/router.ts";
import { spent } from "../reports/format.ts";
import { useApp } from "../ui/context.tsx";
import { EmptyState, SectionHeading } from "../ui/index.tsx";
import { ResultTrail } from "../ui/result-trail.tsx";

/** The tally key a gate counts a result under, when it is one a result can have. */
export const standingOf = (key: string): ResultStanding | null => (isResultStanding(key) ? key : null);

export const Counted = z.object({
	model: z.string().nullable(),
	steps: TrailSchema.nullable(),
	result: z.number(),
	test: z.string(),
	name: z.string(),
	file: z.string().nullable(),
	case: z.string().nullable(),
	outcome: z.string(),
	standing: z.enum(RESULT_STANDINGS),
	quarantined: z.boolean(),
	flipped: z.boolean(),
	recentFlips: z.number(),
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

/** What the results a gate counts took, summed: null when none of them said, and how many did when some did not. */
export function testTimeText(time: { ms: number; timed: number } | undefined, total: number): string | null {
	if (!time || time.timed === 0) return null;
	const some = time.timed < total ? ` (${time.timed} of ${total} results timed)` : "";
	return `${spent(time.ms)} of test time${some}`;
}

type Of = { change: string } | { run: string };

/**
 * The pages of what a gate counted under one filter. The tally and the test time come with every first page,
 * whatever the filter, so a reader that needs only those reads the unfiltered one, which the list shares.
 */
export function useCounted(of: Of, standing: ResultStanding | null, text: string) {
	const { project } = useApp();
	const input = {
		in: "results",
		...of,
		limit: 100,
		...(standing ? { state: standing } : {}),
		...(text ? { text } : {}),
	} satisfies Parameters<typeof call<"find">>[1];
	return useInfiniteQuery({
		queryKey: [...queryKey({ project, op: "find", input }), "pages"],
		initialPageParam: "",
		queryFn: ({ pageParam, signal }) =>
			call("find", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }, { project, signal }),
		getNextPageParam: (page) => page.cursor ?? undefined,
	});
}

/**
 * Every test a gate counted, as it counted it: the evidence behind the verdict. Of a change, the gate of its newest
 * commit; of a run, that run's. The filter is owned by the screen, so the tally above can choose it too.
 */
export function ChangeResults({
	of,
	standing,
	choose,
}: {
	of: Of;
	standing: ResultStanding | null;
	choose: (standing: ResultStanding | null) => void;
}) {
	const { project } = useApp();
	const [typed, setTyped] = useState("");
	const text = useDeferredValue(typed.trim());
	const read = useCounted(of, standing, text);
	const pages = read.data?.pages ?? [];
	const parsed = Counted.array().safeParse(pages.flatMap((page) => page.items));
	const rows = parsed.success ? parsed.data : [];
	const tally = pages[0]?.tally ?? {};
	const flaky = pages[0]?.flaky;
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
				{RESULT_STANDINGS.filter((key) => (tally[key] ?? 0) > 0).map((key) => (
					<button
						type="button"
						key={key}
						aria-pressed={standing === key}
						className={`s-${key}`}
						onClick={() => choose(standing === key ? null : key)}
					>
						{tally[key]} {RESULT_STANDING_LABELS[key]}
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
			{flaky && <FlakyNote flaky={flaky} />}
			{read.error && <p role="status">{read.error.message}</p>}
			{!parsed.success && <p role="status">The results could not be read.</p>}
			<ul className="change-results" aria-label="Results the gate counted">
				{rows.map((row) => (
					<ResultRow key={`${row.result}:${row.job}`} row={row} project={project} days={flaky?.days ?? null} />
				))}
			</ul>
			{rows.length === 0 && !read.isPending && !read.error && (
				<EmptyState doc={{ page: "report-results", label: "How to send a report" }}>
					{total === 0
						? "change" in of
							? "No results counted for the latest commit."
							: "No results counted for this commit."
						: "No result matches."}
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

const times = (n: number, what: string): string => `${n} ${what}${n === 1 ? "" : "s"}`;

/**
 * A failure that a retry may pass is not a reason to stop everything, and a pass that a failure preceded is not a
 * clean pass: both are said above the list, from what the whole commit shows, whatever the filter.
 */
function FlakyNote({ flaky }: { flaky: { flipped: number; failing: number; days: number } }) {
	if (flaky.failing === 0 && flaky.flipped === 0) return null;
	const one = flaky.failing === 1;
	return (
		<div className="change-flaky" role="note">
			{flaky.failing > 0 && (
				<p>
					{one ? "1 failing test" : `${flaky.failing} failing tests`} flipped between passing and failing in the last{" "}
					{times(flaky.days, "day")}, so {one ? "it" : "they"} may be flaky rather than broken. Run{" "}
					{one ? "its job" : "their jobs"} again before fixing {one ? "it" : "them"}: a retry that passes or fails
					counts instead of the failure; one that is skipped or blocked does not.
				</p>
			)}
			{flaky.flipped > 0 && (
				<p>
					{flaky.flipped === 1
						? "1 test both passed and failed on this commit, so it is flaky."
						: `${flaky.flipped} tests both passed and failed on this commit, so they are flaky.`}{" "}
					The gate counts the latest attempt that passed or failed.
				</p>
			)}
		</div>
	);
}

function ResultRow({ row, project, days }: { row: Counted; project: string; days: number | null }) {
	const go = (ref: string) => (event: { preventDefault: () => void }) => {
		event.preventDefault();
		navigate(refUrl({ project, ref }));
	};
	const facts = [
		row.file,
		row.job,
		row.attempt > 1 ? `attempt ${row.attempt}` : null,
		row.flipped
			? "passed and failed on this commit"
			: row.recentFlips > 0 && days !== null
				? `flipped ${times(row.recentFlips, "time")} in the last ${times(days, "day")}`
				: null,
		duration(row.durationMs),
		row.by,
		row.model,
	].filter((fact): fact is string => Boolean(fact));
	const build = webUrl(row.build);
	const flaky = row.flipped || row.recentFlips > 0;
	return (
		<li className={`change-result s-${row.standing}`}>
			<span className="result-standing">
				{row.quarantined ? "quarantined" : RESULT_STANDING_LABELS[row.standing]}
				{row.outcome === "error" && " (error)"}
				{flaky && <span className="result-flaky">flaky</span>}
			</span>
			<div className="result-body">
				<a href={refUrl({ project, ref: row.test })} onClick={go(row.test)}>
					{row.name}
				</a>
				<small className="dim">{facts.join(" · ")}</small>
				{row.message && <small className="result-message">{row.message}</small>}
				<ResultTrail result={row.result} steps={row.steps} />
			</div>
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
