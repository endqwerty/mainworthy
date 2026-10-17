import { ReportsReply } from "../../core/replies.ts";
import { formatRate as percent } from "../../core/reports.ts";
import { useQueryOp } from "../lib/data.ts";
import { useBindings } from "../lib/keys.ts";
import { navigate, refUrl, routeUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { EmptyState, ListRow } from "../ui/index.tsx";
import "./reports.css";

const topics = [
	{ id: "pass-rate", title: "Pass rate over time" },
	{ id: "automation", title: "Automation and backlog" },
	{ id: "requirements", title: "Coverage by requirement" },
	{ id: "flaky", title: "Top flaky tests" },
	{ id: "reruns", title: "Time spent on reruns" },
];

export function ReportsScreen() {
	const { project, route, overlayOpen } = useApp();
	const read = useQueryOp({ project, op: "reports", input: { days: 30 } });
	const parsed = ReportsReply.safeParse(read.data);
	const data = !read.error && !read.isPlaceholderData && parsed.success ? parsed.data : null;
	const selected = topics.find((topic) => topic.id === route.ref) ?? topics[0];
	const choose = (id: string) => navigate(routeUrl({ project, screen: "reports", ref: id }), { replace: true });
	const move = (delta: number) => {
		const topic =
			topics[Math.max(0, Math.min(topics.length - 1, topics.findIndex((item) => item.id === selected?.id) + delta))];
		if (topic) choose(topic.id);
	};
	useBindings([
		{ key: "j", label: "Next report", list: true, when: () => !overlayOpen, handler: () => move(1) },
		{ key: "k", label: "Previous report", list: true, when: () => !overlayOpen, handler: () => move(-1) },
		{
			key: "enter",
			label: "Open report",
			list: true,
			when: () => !overlayOpen,
			handler: () => navigate(routeUrl({ project, screen: "reports", ref: selected?.id ?? "pass-rate" })),
		},
	]);
	const caseLink = (ref: string, title: string) => (
		<a
			href={refUrl({ project, ref })}
			onClick={(event) => {
				event.preventDefault();
				navigate(refUrl({ project, ref }));
			}}
		>
			{ref} · {title}
		</a>
	);
	return (
		<>
			<section className="pane reports-pane" id="list">
				<div className="phead">
					<b>Reports</b>
					<span className="dim">Last 30 UTC days</span>
				</div>
				<div className="pane-scroll" role="listbox" aria-label="Reports">
					{topics.map((topic) => (
						<ListRow key={topic.id} selected={topic === selected} onClick={() => choose(topic.id)}>
							{topic.title}
						</ListRow>
					))}
				</div>
			</section>
			<section className="pane reports-pane" id="detail">
				<div className="phead">
					<b>{selected?.title}</b>
				</div>
				<div className="pane-scroll detail-body reports-body">
					{!data ? (
						<EmptyState>
							{read.error?.message ?? (read.isPending ? "Reading reports…" : "Reports could not be read.")}
						</EmptyState>
					) : (
						<>
							<p className="dim">
								Evidence from {new Date(data.from).toISOString().slice(0, 10)} through{" "}
								{new Date(data.to - 1).toISOString().slice(0, 10)}. Current suite counts are shown separately.
							</p>
							{selected?.id === "pass-rate" && (
								<>
									<p>
										Passes divided by all recorded outcomes, including skip, blocked and error. Each uncorrected attempt
										counts. Decisions do not change these observations. Days with no results are omitted.
									</p>
									{data.days.length ? (
										<table>
											<thead>
												<tr>
													<th>UTC day</th>
													<th>Passes / results</th>
													<th>Pass rate</th>
												</tr>
											</thead>
											<tbody>
												{data.days.map((row) => (
													<tr key={row.day}>
														<th>{row.day}</th>
														<td>
															{row.pass} / {row.total}
														</td>
														<td>
															<meter min={0} max={1} value={row.passRate} aria-label={`Pass rate on ${row.day}`} />{" "}
															{percent(row.passRate)}
														</td>
													</tr>
												))}
											</tbody>
										</table>
									) : (
										<p>No results in this period.</p>
									)}
								</>
							)}
							{selected?.id === "automation" && (
								<>
									<h2>{percent(data.automation.rate)} automated</h2>
									<p>
										{data.automation.automated} of {data.automation.total} active cases have a linked automated test.
										This measures links, not whether the latest result passes.
									</p>
									<h3>Automation backlog</h3>
									<p>
										{data.automation.wanted} active cases request automation and have no linked automated test. Showing
										the first {data.automation.backlog.length}.
									</p>
									<ul>
										{data.automation.backlog.map((row) => (
											<li key={row.ref}>{caseLink(row.ref, row.title)}</li>
										))}
									</ul>
								</>
							)}
							{selected?.id === "requirements" && (
								<>
									<p>
										{data.requirements.covered} of {data.requirements.total} recorded requirements have active cases.
										This counts case links, not passing evidence. Requirements never recorded here cannot be counted.
										Showing the first {data.requirements.items.length}.
									</p>
									<table>
										<thead>
											<tr>
												<th>Requirement</th>
												<th>Active cases</th>
											</tr>
										</thead>
										<tbody>
											{data.requirements.items.map((row) => (
												<tr key={row.key}>
													<th>
														{row.key} {row.title}
													</th>
													<td>{row.cases}</td>
												</tr>
											))}
										</tbody>
									</table>
								</>
							)}
							{selected?.id === "flaky" && (
								<>
									<p>
										Automated tests with both pass and fail on the same target, from the same producer and job, within
										this period. A target includes its environment. This is an observed signal, not a flaky decision.
										Showing up to 50, ordered by affected lanes.
									</p>
									{data.flaky.length ? (
										<table>
											<thead>
												<tr>
													<th>Test</th>
													<th>Affected lanes</th>
												</tr>
											</thead>
											<tbody>
												{data.flaky.map((row) => (
													<tr key={row.ref}>
														<th>
															{row.name}
															<small>
																{row.ref} · {row.key}
															</small>
														</th>
														<td>{row.lanes}</td>
													</tr>
												))}
											</tbody>
										</table>
									) : (
										<p>No same-target pass/fail mixtures in this period.</p>
									)}
								</>
							)}
							{selected?.id === "reruns" && (
								<>
									<h2>{(data.reruns.durationMs / 1000).toFixed(2)} seconds recorded</h2>
									<p>
										{data.reruns.count} automated {data.reruns.count === 1 ? "execution repeats" : "executions repeat"}{" "}
										an earlier execution on the same target, producer and job. The earlier execution may precede this
										period. {data.reruns.missingDuration}{" "}
										{data.reruns.missingDuration === 1 ? "rerun has" : "reruns have"} no duration and{" "}
										{data.reruns.missingDuration === 1 ? "contributes" : "contribute"} no time.
									</p>
									<p>
										Durations add test execution time. Parallel tests can overlap, so this is not elapsed build time or
										staff time lost. Corrections and the results they replace are not counted twice.
									</p>
								</>
							)}
						</>
					)}
				</div>
			</section>
		</>
	);
}
