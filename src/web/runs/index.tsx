import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ResultStanding } from "../../core/runs.ts";
import { ChangeResults } from "../changes/results.tsx";
import { call } from "../lib/api.ts";
import { queryClient, queryKey, useQueryOp } from "../lib/data.ts";
import { useBindings } from "../lib/keys.ts";
import { navigate, routeUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { age, EmptyState, KeyCap, ListRow } from "../ui/index.tsx";
import { RunCockpit } from "./cockpit.tsx";
import { Run, tallyText } from "./models.ts";
import { RunPlanner } from "./planner.tsx";
import "./runs.css";

/**
 * A planned run opens in its cockpit. A change run has no slots to work through: its address opens the list with it
 * selected, and the detail shows what its gate counted.
 */
export function RunsScreen() {
	const { project, route } = useApp();
	const read = useQueryOp({ project, op: "get", input: { refs: [route.ref ?? ""] }, enabled: Boolean(route.ref) });
	const parsed = Run.safeParse(read.data?.[0]);
	const opened = route.ref && parsed.success && parsed.data.ref === route.ref ? parsed.data : null;
	// Which of the two a run is is known once it is read; the cockpit is not drawn for a change run meanwhile.
	if (route.ref && read.isPending)
		return (
			<>
				<section className="pane run-pane" id="list" />
				<section className="pane run-pane" id="detail" />
			</>
		);
	return route.ref && opened?.origin !== "change" ? (
		<RunCockpit key={`${project}:${route.ref}`} runRef={route.ref} />
	) : (
		<RunListing key={project} opened={opened} />
	);
}

/**
 * Goes to a run that a list already read. The screen reads a run before it knows whether to draw a cockpit; a list's
 * row answers that at once, so nothing is drawn empty while the run is read again.
 */
export function openRun(project: string, run: Run): void {
	queryClient.setQueryData(queryKey({ project, op: "get", input: { refs: [run.ref] } }), [run]);
	navigate(routeUrl({ project, screen: "runs", ref: run.ref }));
}

/** Which runs the list shows. Nothing chosen is every one of them. */
type RunFilter = { origin: Run["origin"] | null; state: Run["state"] | null };
const ORIGINS = [
	[null, "All"],
	["planned", "Planned"],
	["change", "Change"],
] as const satisfies readonly (readonly [RunFilter["origin"], string])[];
const STATES = [
	[null, "Any state"],
	["open", "Open"],
	["closed", "Closed"],
] as const satisfies readonly (readonly [RunFilter["state"], string])[];

function RunListing({ opened }: { opened: Run | null }) {
	const { project, route, overlayOpen } = useApp();
	const [planning, setPlanning] = useState(false);
	const [filter, setFilter] = useState<RunFilter>({ origin: null, state: null });
	const [chosen, setChosen] = useState<string | null>(opened?.ref ?? null);
	// An address that names another run, by Back, Forward or a jump, selects it.
	const [addressed, setAddressed] = useState<string | null>(opened?.ref ?? null);
	if ((opened?.ref ?? null) !== addressed) {
		setAddressed(opened?.ref ?? null);
		if (opened) setChosen(opened.ref);
	}
	const input = {
		in: "runs",
		limit: 100,
		...(filter.origin ? { origin: filter.origin } : {}),
		...(filter.state ? { state: filter.state } : {}),
	} satisfies Parameters<typeof call<"find">>[1];
	const read = useInfiniteQuery({
		queryKey: [...queryKey({ project, op: "find", input }), "pages"],
		initialPageParam: "",
		queryFn: ({ pageParam, signal }) =>
			call("find", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }, { project, signal }),
		getNextPageParam: (page) => page.cursor ?? undefined,
	});
	const parsed = Run.array().safeParse(read.data?.pages.flatMap((page) => page.items));
	const runs = parsed.success ? parsed.data : [];
	// The run whose address was opened is shown even when the list has not reached it, or a filter hides it.
	const selected =
		runs.find((run) => run.ref === chosen) ?? (opened && opened.ref === chosen ? opened : null) ?? runs[0];
	const choose = (run: string) => {
		setChosen(run);
		setPlanning(false);
		// The address names the run it opened; once another is chosen, it names none.
		if (route.ref && route.ref !== run) navigate(routeUrl({ project, screen: "runs" }), { replace: true });
	};
	const move = (delta: number) => {
		const index = runs.findIndex((run) => run.ref === selected?.ref);
		const next = runs[Math.max(0, Math.min(runs.length - 1, index + delta))];
		if (next) choose(next.ref);
	};
	const open = (run: Run) =>
		run.origin === "planned"
			? openRun(project, run)
			: run.change && navigate(routeUrl({ project, screen: "changes", ref: run.change.key }));
	const active = () => !overlayOpen && !planning;
	useBindings([
		{ key: "n", label: "Plan run", list: true, when: active, handler: () => setPlanning(true) },
		{ key: "j", label: "Next run", when: active, handler: () => move(1) },
		{ key: "k", label: "Previous run", when: active, handler: () => move(-1) },
		{
			key: "enter",
			label: selected?.origin === "change" ? "Open change" : "Open cockpit",
			when: () => active() && Boolean(selected && (selected.origin === "planned" || selected.change)),
			handler: () => {
				if (selected) open(selected);
			},
		},
	]);
	const filtered = filter.origin !== null || filter.state !== null;
	return (
		<>
			<section className="pane run-pane" id="list">
				<div className="phead">
					<b>Runs</b>
					<span className="dim">newest first</span>
					<button className="out run-plan-button" type="button" onClick={() => setPlanning(true)}>
						<KeyCap>n</KeyCap> Plan run
					</button>
				</div>
				<div className="run-filters">
					<fieldset className="run-filter" aria-label="Kind of run">
						{ORIGINS.map(([origin, label]) => (
							<button
								type="button"
								key={label}
								aria-pressed={filter.origin === origin}
								onClick={() => setFilter({ ...filter, origin })}
							>
								{label}
							</button>
						))}
					</fieldset>
					<fieldset className="run-filter" aria-label="State of run">
						{STATES.map(([state, label]) => (
							<button
								type="button"
								key={label}
								aria-pressed={filter.state === state}
								onClick={() => setFilter({ ...filter, state })}
							>
								{label}
							</button>
						))}
					</fieldset>
				</div>
				<div className="pane-scroll" role="listbox" aria-label="Runs">
					{runs.map((run) => (
						<ListRow key={run.ref} selected={selected?.ref === run.ref} onClick={() => choose(run.ref)}>
							<span className="ref">{run.ref}</span>
							<span className="run-title">
								<b>{run.name}</b>
								<span className="run-list-reason">{run.reason}</span>
							</span>
							{run.state === "closed" && <span className="run-closed">closed</span>}
							<span className={`run-verdict v-${run.verdict}`}>{run.verdict}</span>
							<span className="dim mono run-list-kind">
								{run.origin === "planned" ? `${run.slots ?? 0} slots` : "change"}
							</span>
							<time
								className="dim mono run-list-age"
								dateTime={new Date(run.createdAt).toISOString()}
								title={new Date(run.createdAt).toLocaleString()}
							>
								{age(run.createdAt)}
							</time>
						</ListRow>
					))}
					{!runs.length && (
						<EmptyState
							{...(!read.error && !read.isPending && !filtered
								? { doc: { page: "runs", label: "How a planned run works" } }
								: {})}
						>
							{read.error?.message ??
								(read.isPending
									? "Reading runs…"
									: filtered
										? "No run matches."
										: "No runs yet. Press n to plan one, or send a pipeline report.")}
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
				) : selected?.origin === "change" ? (
					<ChangeRunDetail key={selected.ref} run={selected} />
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
								: "build" in selected.accepts
									? `Accepts results for build ${selected.accepts.build}${selected.accepts.env ? ` in ${selected.accepts.env}` : ""}.`
									: `Accepts results for commit ${selected.accepts.commit}.`}
						</p>
						<button className="out" type="button" onClick={() => open(selected)}>
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

/** A change run: one reported commit's gate, and every result it counted. */
function ChangeRunDetail({ run }: { run: Run }) {
	const { project } = useApp();
	const [standing, setStanding] = useState<ResultStanding | null>(null);
	const change = run.change;
	return (
		<div className="pane-scroll detail-body">
			<div className="run-document-meta">
				<span className="ref">{run.ref}</span>
				<span>
					{run.state} · {age(run.createdAt)} · first reported by {run.createdBy}
				</span>
			</div>
			<h2>{run.name}</h2>
			<p className={`run-verdict v-${run.verdict}`}>{run.reason}</p>
			<p className="dim">{tallyText(run.tally)}</p>
			{"commit" in run.accepts && (
				<p className="dim">
					Commit <code>{run.accepts.commit}</code>
				</p>
			)}
			{change && (
				<>
					<p>
						<span className="ref">{change.key}</span> {change.title ?? ""}
					</p>
					<button
						className="out"
						type="button"
						onClick={() => navigate(routeUrl({ project, screen: "changes", ref: change.key }))}
					>
						<KeyCap>Enter</KeyCap> Open change
					</button>
				</>
			)}
			<ChangeResults of={{ run: run.ref }} standing={standing} choose={setStanding} />
		</div>
	);
}
