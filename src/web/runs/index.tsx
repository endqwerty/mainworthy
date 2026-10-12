import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { call } from "../lib/api.ts";
import { queryKey } from "../lib/data.ts";
import { useBindings } from "../lib/keys.ts";
import { navigate, routeUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { age, EmptyState, KeyCap, ListRow } from "../ui/index.tsx";
import { RunCockpit } from "./cockpit.tsx";
import { Run, tallyText } from "./models.ts";
import { RunPlanner } from "./planner.tsx";
import "./runs.css";

export function RunsScreen() {
	const { project, route } = useApp();
	return route.ref ? <RunCockpit key={`${project}:${route.ref}`} runRef={route.ref} /> : <RunListing key={project} />;
}
function RunListing() {
	const { project, overlayOpen } = useApp();
	const [planning, setPlanning] = useState(false);
	const [cursor, setCursor] = useState(0);
	const input = { in: "runs", limit: 100 } satisfies Parameters<typeof call<"find">>[1];
	const read = useInfiniteQuery({
		queryKey: [...queryKey({ project, op: "find", input }), "pages"],
		initialPageParam: "",
		queryFn: ({ pageParam, signal }) =>
			call("find", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }, { project, signal }),
		getNextPageParam: (page) => page.cursor ?? undefined,
	});
	const parsed = Run.array().safeParse(read.data?.pages.flatMap((page) => page.items));
	const runs = parsed.success ? parsed.data : [];
	const selected = runs[cursor] ?? runs[0];
	const open = (run: string) => navigate(routeUrl({ project, screen: "runs", ref: run }));
	const active = () => !overlayOpen && !planning;
	useBindings([
		{ key: "n", label: "Plan run", when: active, handler: () => setPlanning(true) },
		{
			key: "j",
			label: "Next run",
			when: active,
			handler: () => setCursor((value) => Math.min(runs.length - 1, value + 1)),
		},
		{ key: "k", label: "Previous run", when: active, handler: () => setCursor((value) => Math.max(0, value - 1)) },
		{
			key: "enter",
			label: "Open cockpit",
			when: () => active() && Boolean(selected),
			handler: () => {
				if (selected) open(selected.ref);
			},
		},
	]);
	return (
		<>
			<section className="pane run-pane" id="list">
				<div className="phead">
					<b>Runs</b>
					<span className="dim">planned evidence</span>
					<button className="out run-plan-button" type="button" onClick={() => setPlanning(true)}>
						<KeyCap>n</KeyCap> Plan run
					</button>
				</div>
				<div className="pane-scroll" role="listbox" aria-label="Planned runs">
					{runs.map((run, index) => (
						<ListRow
							key={run.ref}
							selected={selected?.ref === run.ref}
							onClick={() => {
								setCursor(index);
								setPlanning(false);
							}}
						>
							<span className="ref">{run.ref}</span>
							<span className="run-title">
								<b>{run.name}</b>
								<span className="run-list-reason">{run.reason}</span>
							</span>
							<span className={`run-verdict v-${run.verdict}`}>{run.verdict}</span>
							<span className="dim mono">{run.slots ?? 0} slots</span>
						</ListRow>
					))}
					{!runs.length && (
						<EmptyState>
							{read.error?.message ?? (read.isPending ? "Reading runs…" : "No runs yet. Press n to plan one.")}
						</EmptyState>
					)}
					{read.hasNextPage && (
						<button type="button" className="run-more" onClick={() => void read.fetchNextPage()}>
							More runs
						</button>
					)}
				</div>
			</section>
			<section className="pane run-pane" id="detail">
				{planning ? (
					<>
						<div className="phead">
							<b>Plan a run</b>
						</div>
						<div className="pane-scroll">
							<RunPlanner close={() => setPlanning(false)} />
						</div>
					</>
				) : selected ? (
					<div className="pane-scroll detail-body">
						<div className="run-document-meta">
							<span className="ref">{selected.ref}</span>
							<span>
								{selected.state} · {age(selected.createdAt)} · by {selected.createdBy}
							</span>
						</div>
						<h2>{selected.name}</h2>
						<p className={`run-verdict v-${selected.verdict}`}>{selected.reason}</p>
						<p className="dim">{tallyText(selected.tally)}</p>
						<div
							className="run-list-progress"
							role="progressbar"
							aria-label="Run completion"
							aria-valuemin={0}
							aria-valuemax={selected.slots ?? 0}
							aria-valuenow={Math.max(0, (selected.slots ?? 0) - selected.tally.missing)}
						>
							<span
								style={{
									width: `${selected.slots ? Math.max(0, 100 * (1 - selected.tally.missing / selected.slots)) : 0}%`,
								}}
							/>
						</div>
						<p className="dim">
							{selected.slots ?? 0} pinned cases · {selected.tally.missing} missing
						</p>
						<p>
							{"self" in selected.accepts
								? "Counts only its own results; proves nothing about a build."
								: `Accepts results for commit ${selected.accepts.commit}.`}
						</p>
						<button className="out" type="button" onClick={() => open(selected.ref)}>
							<KeyCap>Enter</KeyCap> Open cockpit
						</button>
					</div>
				) : (
					<EmptyState>Press n to name a run and choose its cases.</EmptyState>
				)}
			</section>
		</>
	);
}
