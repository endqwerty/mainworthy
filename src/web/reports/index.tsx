import { useState } from "react";
import type { Api } from "../../core/api.ts";
import { MethodKind } from "../../core/model.ts";
import type { OutcomeCounts, StatsKind } from "../../core/stats.ts";
import { useQueryOp } from "../lib/data.ts";
import { useBindings } from "../lib/keys.ts";
import { navigate, refUrl, routeUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { age, EmptyState, ListRow, SectionHeading, Select } from "../ui/index.tsx";
import { count, percent, spent } from "./format.ts";
import "./reports.css";

/** The reports, in the order the list shows them. */
const REPORTS: readonly { of: StatsKind; label: string }[] = [
	{ of: "pass-rate", label: "Pass rate" },
	{ of: "flaky", label: "Flaky tests" },
	{ of: "reruns", label: "Time lost to reruns" },
	{ of: "automation", label: "Automation" },
	{ of: "coverage", label: "Coverage by requirement" },
];
const WINDOWS = [7, 14, 30, 90] as const;
const PRODUCERS: readonly { value: MethodKind | ""; label: string }[] = [
	{ value: "", label: "Every producer" },
	{ value: "auto", label: "Pipelines" },
	{ value: "human", label: "People" },
	{ value: "agent", label: "Agents" },
];
/** The reader's own days: a result at six in the evening counts on that day here, whatever UTC says. */
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const isKind = (value: string | null): value is StatsKind => REPORTS.some((report) => report.of === value);

/** What a report is asked for: the pass rate takes the reader's zone and a producer, the others a window alone. */
function inputOf(of: StatsKind, days: number, method: MethodKind | null = null): Api["stats"]["input"] {
	switch (of) {
		case "pass-rate":
			return { of, days, zone, ...(method ? { method } : {}) };
		case "flaky":
		case "reruns":
		case "automation":
		case "coverage":
			return { of, days };
	}
}

/** The stats read of one report: the list's headline and the detail share it, so each is read once. */
function useReport(input: Api["stats"]["input"]) {
	const { project } = useApp();
	return useQueryOp({ project, op: "stats", input });
}

export function ReportsScreen() {
	const { project } = useApp();
	return <ReportsWorkbench key={project} />;
}

/** What the stream of results says over the last days: one row per report, and the selected one beside the list. */
function ReportsWorkbench() {
	const { project, route } = useApp();
	const [days, setDays] = useState<number>(30);
	const selected: StatsKind = isKind(route.ref) ? route.ref : "pass-rate";
	const choose = (of: StatsKind) => navigate(routeUrl({ project, screen: "reports", ref: of }), { replace: true });
	const move = (delta: number) => {
		const index = REPORTS.findIndex((report) => report.of === selected);
		const next = REPORTS[Math.max(0, Math.min(REPORTS.length - 1, index + delta))];
		if (next) choose(next.of);
	};
	useBindings([
		{ key: "j", label: "Next report", handler: () => move(1) },
		{ key: "k", label: "Previous report", handler: () => move(-1) },
	]);
	return (
		<>
			<section className="pane reports-pane" id="list">
				<div className="phead">
					<b>Reports</b>
					<span className="dim">from every result</span>
				</div>
				<div className="reports-window">
					<label>
						Last{" "}
						<Select
							aria-label="Days to read"
							value={String(days)}
							onChange={(event) => setDays(Number(event.currentTarget.value))}
						>
							{WINDOWS.map((n) => (
								<option key={n} value={n}>
									{n} days
								</option>
							))}
						</Select>
					</label>
				</div>
				<div className="pane-scroll" role="listbox" aria-label="Reports">
					{REPORTS.map((report) => (
						<ListRow key={report.of} selected={selected === report.of} onClick={() => choose(report.of)}>
							<span className="report-title">
								<b>{report.label}</b>
								<Headline of={report.of} days={days} />
							</span>
						</ListRow>
					))}
				</div>
			</section>
			<section className="pane reports-pane" id="detail">
				<div className="phead">
					<b>{REPORTS.find((report) => report.of === selected)?.label}</b>
					<span className="dim">last {days} days</span>
				</div>
				<div className="pane-scroll detail-body">
					<Detail key={selected} of={selected} days={days} />
				</div>
			</section>
		</>
	);
}

/** The one line under a report's name in the list. */
function Headline({ of, days }: { of: StatsKind; days: number }) {
	const read = useReport(inputOf(of, days));
	const data = read.data;
	const text = !data
		? read.error
			? "could not be read"
			: "reading…"
		: data.of === "pass-rate"
			? data.total.pass + data.total.fail === 0
				? "no passes or failures"
				: `${percent(data.total.rate)} of ${data.total.pass + data.total.fail} passed`
			: data.of === "flaky"
				? `${data.flaky} of ${count(data.tests, "test")} flipped`
				: data.of === "reruns"
					? data.reruns === 0
						? "no reruns"
						: `${spent(data.lostMs)} in ${count(data.reruns, "rerun")}`
					: data.of === "automation"
						? `${percent(data.rate)} of what can be automated`
						: `${data.covered} of ${data.requirements} requirements covered`;
	return <span className="dim">{text}</span>;
}

function Detail({ of, days }: { of: StatsKind; days: number }) {
	switch (of) {
		case "pass-rate":
			return <PassRate days={days} />;
		case "flaky":
			return <Flaky days={days} />;
		case "reruns":
			return <Reruns days={days} />;
		case "automation":
			return <Automation days={days} />;
		case "coverage":
			return <Coverage days={days} />;
	}
}

function Unread({ read, what }: { read: { error: Error | null }; what: string }) {
	return <EmptyState>{read.error?.message ?? `Reading ${what}…`}</EmptyState>;
}

function useGo() {
	const { project } = useApp();
	return (ref: string) => ({
		href: refUrl({ project, ref }),
		onClick: (event: { preventDefault: () => void }) => {
			event.preventDefault();
			navigate(refUrl({ project, ref }));
		},
	});
}

const counted = (counts: OutcomeCounts) => counts.pass + counts.fail;

/**
 * The daily rate as a line. Its scale starts at the lowest day's rate rounded down to a ten, not at zero: rates sit
 * near the top, and a scale from zero draws every day at the same height. The two ends of the scale are labelled.
 */
function RateChart({ days }: { days: readonly (OutcomeCounts & { day: string })[] }) {
	const rates = days.flatMap((day) => (day.rate === null ? [] : [day.rate]));
	const floor = Math.min(0.9, Math.floor(Math.min(...rates, 1) * 10) / 10);
	const x = (i: number) => (days.length === 1 ? 50 : (i / (days.length - 1)) * 100);
	const y = (rate: number) => ((rate - floor) / (1 - floor)) * 100;
	// A day with nothing passed or failed breaks the line rather than drawing it through zero.
	const segments: string[][] = [[]];
	days.forEach((day, i) => {
		if (day.rate === null) segments.push([]);
		else segments.at(-1)?.push(`${x(i)},${100 - y(day.rate)}`);
	});
	return (
		<>
			<div className="rate-chart" role="img" aria-label="Pass rate per day; the numbers are in the table below">
				<span className="rate-scale rate-top">100%</span>
				<span className="rate-scale rate-floor">{Math.round(floor * 100)}%</span>
				<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
					{segments
						.filter((points) => points.length > 1)
						.map((points) => (
							<polyline key={points[0]} points={points.join(" ")} vectorEffect="non-scaling-stroke" />
						))}
				</svg>
				{days.map((day, i) =>
					day.rate === null ? null : (
						<span
							key={day.day}
							className="rate-dot"
							style={{ left: `${x(i)}%`, bottom: `${y(day.rate)}%` }}
							title={`${day.day}: ${percent(day.rate)} of ${counted(day)} passed`}
						/>
					),
				)}
			</div>
			<div className="rate-axis dim">
				<span>{days[0]?.day}</span>
				<span>{days.at(-1)?.day}</span>
			</div>
		</>
	);
}

function PassRate({ days }: { days: number }) {
	const [method, setMethod] = useState<MethodKind | null>(null);
	const read = useReport(inputOf("pass-rate", days, method));
	const data = read.data?.of === "pass-rate" ? read.data : undefined;
	return (
		<>
			<div className="reports-filter">
				<Select
					aria-label="Whose results"
					value={method ?? ""}
					onChange={(event) => setMethod(MethodKind.safeParse(event.currentTarget.value).data ?? null)}
				>
					{PRODUCERS.map((producer) => (
						<option key={producer.value} value={producer.value}>
							{producer.label}
						</option>
					))}
				</Select>
			</div>
			{!data ? (
				<Unread read={read} what="the pass rate" />
			) : (
				<>
					<p className="report-hero">
						<b>{percent(data.total.rate)}</b>{" "}
						<span className="dim">
							of {counted(data.total)} results passed
							{data.total.quarantined > 0 && `, not counting ${count(data.total.quarantined, "quarantined failure")}`}
						</span>
					</p>
					<RateChart days={data.days} />
					<table className="report-table">
						<caption className="sr-only">Results per day</caption>
						<thead>
							<tr>
								<th scope="col">Day</th>
								<th scope="col">Rate</th>
								<th scope="col">Passed</th>
								<th scope="col">Failed</th>
								<th scope="col">Quarantined</th>
								<th scope="col">Skipped</th>
								<th scope="col">Blocked</th>
							</tr>
						</thead>
						<tbody>
							{[...data.days].reverse().map((day) => (
								<tr key={day.day}>
									<th scope="row">{day.day}</th>
									<td>{day.rate === null ? "" : percent(day.rate)}</td>
									<td>{day.pass}</td>
									<td>{day.fail}</td>
									<td>{day.quarantined}</td>
									<td>{day.skip}</td>
									<td>{day.blocked}</td>
								</tr>
							))}
						</tbody>
					</table>
					<p className="dim report-note">
						Each test counts once for each job and producer on each commit, by the attempt it ended with. Days are{" "}
						{data.zone}'s.
					</p>
				</>
			)}
		</>
	);
}

function Flaky({ days }: { days: number }) {
	const read = useReport(inputOf("flaky", days));
	const data = read.data?.of === "flaky" ? read.data : undefined;
	const go = useGo();
	if (!data) return <Unread read={read} what="flaky tests" />;
	return (
		<>
			<p className="report-hero">
				<b>{data.flaky}</b>{" "}
				<span className="dim">of {count(data.tests, "automated test")} passed and failed on the same code</span>
			</p>
			{data.items.length === 0 ? (
				<p className="dim">No test flipped in these days.</p>
			) : (
				<table className="report-table">
					<thead>
						<tr>
							<th scope="col">Test</th>
							<th scope="col">Flips</th>
							<th scope="col">Last</th>
						</tr>
					</thead>
					<tbody>
						{data.items.map((item) => (
							<tr key={item.test}>
								<th scope="row">
									<a className="ref" {...go(item.test)}>
										{item.test}
									</a>{" "}
									{item.name}
									{item.quarantined && <span className="report-tag">quarantined</span>}
								</th>
								<td>{item.flips}</td>
								<td>{age(item.lastAt)}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</>
	);
}

function Reruns({ days }: { days: number }) {
	const read = useReport(inputOf("reruns", days));
	const data = read.data?.of === "reruns" ? read.data : undefined;
	const go = useGo();
	if (!data) return <Unread read={read} what="reruns" />;
	return (
		<>
			<p className="report-hero">
				<b>{spent(data.lostMs)}</b>{" "}
				<span className="dim">
					in {count(data.reruns, "attempt")} that {data.reruns === 1 ? "was" : "were"} run again
					{data.unknown > 0 && `; ${data.unknown} of them said no duration`}
				</span>
			</p>
			{data.items.length === 0 ? (
				<p className="dim">Nothing was run again in these days.</p>
			) : (
				<table className="report-table">
					<thead>
						<tr>
							<th scope="col">Test</th>
							<th scope="col">Reruns</th>
							<th scope="col">Time</th>
						</tr>
					</thead>
					<tbody>
						{data.items.map((item) => (
							<tr key={item.test}>
								<th scope="row">
									<a className="ref" {...go(item.test)}>
										{item.test}
									</a>{" "}
									{item.name}
								</th>
								<td>{item.reruns}</td>
								<td>{spent(item.lostMs)}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</>
	);
}

function Automation({ days }: { days: number }) {
	const read = useReport(inputOf("automation", days));
	const data = read.data?.of === "automation" ? read.data : undefined;
	const go = useGo();
	if (!data) return <Unread read={read} what="automation" />;
	return (
		<>
			<p className="report-hero">
				<b>{percent(data.rate)}</b>{" "}
				<span className="dim">
					of the cases that can be automated have an automated test ({data.automated} of{" "}
					{data.cases - data.manual.notApplicable})
				</span>
			</p>
			<dl className="report-facts">
				<dt>Automated</dt>
				<dd>{data.automated}</dd>
				<dt>To automate</dt>
				<dd>{data.manual.wanted}</dd>
				<dt>Not decided</dt>
				<dd>{data.manual.none}</dd>
				<dt>Cannot be automated</dt>
				<dd>{data.manual.notApplicable}</dd>
			</dl>
			<SectionHeading>Backlog: run by hand most often</SectionHeading>
			{data.backlog.length === 0 ? (
				<p className="dim">Every case that can be automated has an automated test.</p>
			) : (
				<table className="report-table">
					<thead>
						<tr>
							<th scope="col">Case</th>
							<th scope="col">Runs by hand</th>
							<th scope="col">Time</th>
						</tr>
					</thead>
					<tbody>
						{data.backlog.map((item) => (
							<tr key={item.case}>
								<th scope="row">
									<a className="ref" {...go(item.case)}>
										{item.case}
									</a>{" "}
									{item.title}
									{item.automate === "wanted" && <span className="report-tag">to automate</span>}
								</th>
								<td>{item.runs}</td>
								<td>{item.timeMs === null ? "" : spent(item.timeMs)}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</>
	);
}

function Coverage({ days }: { days: number }) {
	const read = useReport(inputOf("coverage", days));
	const data = read.data?.of === "coverage" ? read.data : undefined;
	if (!data) return <Unread read={read} what="coverage" />;
	return (
		<>
			<p className="report-hero">
				<b>
					{data.covered} of {data.requirements}
				</b>{" "}
				<span className="dim">requirements have a case</span>
			</p>
			{data.items.length === 0 ? (
				<EmptyState doc={{ page: "write-cases", label: "How a case covers a requirement" }}>
					No requirements yet.
				</EmptyState>
			) : (
				<table className="report-table">
					<thead>
						<tr>
							<th scope="col">Requirement</th>
							<th scope="col">Cases</th>
							<th scope="col">Passed</th>
							<th scope="col">Failed</th>
							<th scope="col">Skipped or blocked</th>
							<th scope="col">Not run</th>
						</tr>
					</thead>
					<tbody>
						{data.items.map((item) => (
							<tr key={item.key} className={item.cases === 0 ? "report-gap" : undefined}>
								<th scope="row">
									<span className="mono">{item.key}</span> {item.title}
								</th>
								<td>{item.cases === 0 ? "none" : item.cases}</td>
								<td>{item.passed}</td>
								<td>{item.failed}</td>
								<td>{item.other}</td>
								<td>{item.notRun}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<p className="dim report-note">A case counts by the latest result of each of its tests in these days.</p>
		</>
	);
}
