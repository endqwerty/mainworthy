import { useInfiniteQuery } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { z } from "zod";
import { Quarantine } from "../../core/flaky.ts";
import { duration, webUrl } from "../changes/results.tsx";
import { call } from "../lib/api.ts";
import { queryKey, useQueryOp } from "../lib/data.ts";
import { useBindings } from "../lib/keys.ts";
import { navigate, refUrl, routeUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { age, EmptyState, ListRow, SectionHeading } from "../ui/index.tsx";
import { quarantineExitText } from "../ui/quarantine.tsx";
import "./tests.css";

const Test = z.object({
	ref: z.string(),
	name: z.string(),
	file: z.string().nullable(),
	case: z.string().nullable(),
	quarantine: Quarantine.nullable(),
});
const Result = z.object({
	id: z.number(),
	outcome: z.string(),
	by: z.string(),
	at: z.number(),
	attempt: z.number(),
	durationMs: z.number().nullable(),
	message: z.string().nullable(),
	commit: z.string().nullable(),
	change: z.string().nullable(),
	job: z.string(),
	build: z.string().nullable(),
});
const Detail = Test.extend({ key: z.string(), flips: z.number(), last: z.array(Result) });

export function TestsScreen() {
	const { project } = useApp();
	return <TestsWorkbench key={project} />;
}

/** Every automated test the project has seen, with a case or without one, and what each of its results was. */
function TestsWorkbench() {
	const { project, route, overlayOpen } = useApp();
	const [typed, setTyped] = useState("");
	const [unlinked, setUnlinked] = useState(false);
	const text = useDeferredValue(typed.trim());
	const input = {
		in: "tests",
		limit: 100,
		...(text ? { text } : {}),
		...(unlinked ? { unlinked } : {}),
	} satisfies Parameters<typeof call<"find">>[1];
	const read = useInfiniteQuery({
		queryKey: [...queryKey({ project, op: "find", input }), "pages"],
		initialPageParam: "",
		queryFn: ({ pageParam, signal }) =>
			call("find", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }, { project, signal }),
		getNextPageParam: (page) => page.cursor ?? undefined,
	});
	const parsed = Test.array().safeParse(read.data?.pages.flatMap((page) => page.items));
	const tests = parsed.success ? parsed.data : [];
	const selected = route.ref ?? tests[0]?.ref ?? null;
	const choose = (ref: string) => navigate(routeUrl({ project, screen: "tests", ref }), { replace: true });
	const move = (delta: number) => {
		const index = tests.findIndex((test) => test.ref === selected);
		const next = tests[Math.max(0, Math.min(tests.length - 1, index + delta))];
		if (next) choose(next.ref);
	};
	useBindings([
		{ key: "j", label: "Next test", when: () => !overlayOpen, handler: () => move(1) },
		{ key: "k", label: "Previous test", when: () => !overlayOpen, handler: () => move(-1) },
	]);
	return (
		<>
			<section className="pane tests-pane" id="list">
				<div className="phead">
					<b>Tests</b>
					<span className="dim">what each automated test did</span>
				</div>
				<div className="tests-filter">
					<input
						type="search"
						aria-label="Filter tests by name or file"
						placeholder="Filter by name or file"
						value={typed}
						onChange={(event) => setTyped(event.target.value)}
					/>
					<label>
						<input type="checkbox" checked={unlinked} onChange={(event) => setUnlinked(event.target.checked)} /> Only
						tests with no case
					</label>
				</div>
				<div className="pane-scroll" role="listbox" aria-label="Tests">
					{tests.map((test) => (
						<ListRow key={test.ref} selected={selected === test.ref} onClick={() => choose(test.ref)}>
							<span className="ref">{test.ref}</span>
							<span className="test-title">
								<b>{test.name}</b>
								<span className="dim">{test.file ?? "no file"}</span>
							</span>
							<span className="dim mono">{test.case ?? "no case"}</span>
						</ListRow>
					))}
					{!tests.length && (
						<EmptyState
							{...(!read.error && !read.isPending
								? { doc: { page: "report-results", label: "How to send a report" } }
								: {})}
						>
							{read.error?.message ??
								(read.isPending
									? "Reading tests…"
									: text || unlinked
										? "No test matches."
										: "No tests yet. A pipeline report adds the tests it ran.")}
						</EmptyState>
					)}
					{read.hasNextPage && (
						<button type="button" className="tests-more" onClick={() => void read.fetchNextPage()}>
							More tests
						</button>
					)}
				</div>
			</section>
			<section className="pane tests-pane" id="detail">
				{selected ? (
					<TestDetail key={selected} testRef={selected} />
				) : (
					<EmptyState>Select a test to see its results.</EmptyState>
				)}
			</section>
		</>
	);
}

function TestDetail({ testRef }: { testRef: string }) {
	const { project } = useApp();
	const read = useQueryOp({ project, op: "get", input: { refs: [testRef] } });
	const parsed = Detail.safeParse(read.data?.[0]);
	const go = (ref: string) => (event: { preventDefault: () => void }) => {
		event.preventDefault();
		navigate(refUrl({ project, ref }));
	};
	if (!parsed.success)
		return (
			<EmptyState>
				{read.error?.message ?? (read.isPending ? "Reading the test…" : "The test could not be read.")}
			</EmptyState>
		);
	const test = parsed.data;
	return (
		<>
			<div className="phead">
				<span className="ref">{test.ref}</span>
				<b className="test-title">{test.name}</b>
			</div>
			<div className="pane-scroll detail-body">
				<dl className="test-facts">
					<dt>File</dt>
					<dd className="mono">{test.file ?? "none reported"}</dd>
					<dt>Key</dt>
					<dd className="mono">{test.key}</dd>
					<dt>Case</dt>
					<dd>
						{test.case ? (
							<a className="ref" href={refUrl({ project, ref: test.case })} onClick={go(test.case)}>
								{test.case}
							</a>
						) : (
							"None: the test is tracked without a case."
						)}
					</dd>
					{test.flips > 0 && (
						<>
							<dt>Flips</dt>
							<dd>{test.flips} times between passing and failing on the same code</dd>
						</>
					)}
					{test.quarantine?.active && (
						<>
							<dt>Quarantined</dt>
							<dd>
								{test.quarantine.reason} · {quarantineExitText(test.quarantine.exit)}
							</dd>
						</>
					)}
				</dl>
				<SectionHeading>Latest results</SectionHeading>
				<ul className="test-results" aria-label="Latest results">
					{test.last.map((result) => {
						const build = webUrl(result.build);
						const facts = [
							result.job,
							result.attempt > 1 ? `attempt ${result.attempt}` : null,
							duration(result.durationMs),
							result.by,
							age(result.at),
						].filter((fact): fact is string => Boolean(fact));
						return (
							<li key={result.id} className={`test-result o-${result.outcome}`}>
								<span className="result-outcome">{result.outcome}</span>
								<span className="result-body">
									<span>
										{result.commit && <span className="mono">{result.commit.slice(0, 12)}</span>}
										{result.change && (
											<>
												{" "}
												<a href={refUrl({ project, ref: result.change })} onClick={go(result.change)}>
													{result.change}
												</a>
											</>
										)}
									</span>
									<small className="dim">{facts.join(" · ")}</small>
									{result.message && <small className="result-message">{result.message}</small>}
								</span>
								{build && (
									<a href={build} target="_blank" rel="noreferrer noopener">
										build
									</a>
								)}
							</li>
						);
					})}
				</ul>
				{test.last.length === 0 && <p className="dim">No results yet.</p>}
			</div>
		</>
	);
}
