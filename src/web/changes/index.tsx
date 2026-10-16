import { useState } from "react";
import { z } from "zod";
import { ANSWER_LABELS } from "../../core/kinds.ts";
import { RESULT_STANDING_LABELS, type ResultStanding, Verdict } from "../../core/runs.ts";
import { useQueryOp } from "../lib/data.ts";
import { useBindings } from "../lib/keys.ts";
import { navigate, refUrl, routeUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { age, EmptyState, ListRow, ProducerGlyph, SectionHeading } from "../ui/index.tsx";
import { ChangeResults, standingOf } from "./results.tsx";
import "./changes.css";

const Change = z.object({
	key: z.string(),
	title: z.string().nullable(),
	branch: z.string().nullable(),
	head: z.string().nullable(),
	url: z.string().nullable(),
	state: z.enum(["merged", "closed", "open"]),
	verdict: Verdict.nullable(),
	reason: z.string().nullable(),
});
const Impact = z.object({
	counts: z.object({ cases: z.number(), unreviewed: z.number(), failing: z.number(), uncovered: z.number() }),
	cases: z.array(
		z.object({
			id: z.string(),
			title: z.string(),
			why: z.array(z.string()),
			reviewed: z.boolean().optional(),
			last: z.string().nullable(),
		}),
	),
	uncovered: z.array(z.string()),
	policy: z.string(),
});

export function ChangesScreen() {
	const { project } = useApp();
	return <ChangesWorkbench key={project} />;
}
function ChangesWorkbench() {
	const { project, route, overlayOpen } = useApp();
	const [cursor, setCursor] = useState<string | null>(null);
	const [standing, setStanding] = useState<ResultStanding | null>(null);
	const read = useQueryOp({ project, op: "find", input: { in: "changes", limit: 100 } });
	const parsed = Change.array().safeParse(read.data?.items);
	const changes = parsed.success ? parsed.data : [];
	const key = route.ref ?? cursor ?? changes[0]?.key ?? null;
	const current = changes.find((item) => item.key === key);
	const gate = useQueryOp({ project, op: "gate", input: { change: key ?? "" }, enabled: Boolean(key) });
	const open = useQueryOp({
		project,
		op: "inbox",
		input: { state: "open", on: key ?? "", limit: 500 },
		enabled: Boolean(key),
	});
	const settled = useQueryOp({
		project,
		op: "inbox",
		input: { state: "decided", on: key ?? "", limit: 500 },
		enabled: Boolean(key),
	});
	const impact = useQueryOp({ project, op: "impact", input: { change: key ?? "" }, enabled: Boolean(key) });
	const gateData = gate.isPlaceholderData ? undefined : gate.data;
	const openData = open.isPlaceholderData ? undefined : open.data;
	const settledData = settled.isPlaceholderData ? undefined : settled.data;
	const impactData = Impact.safeParse(impact.isPlaceholderData ? undefined : impact.data);
	const go = (ref: string) => navigate(refUrl({ project, ref }));
	const choose = (change: string) => {
		setCursor(change);
		setStanding(null);
		navigate(routeUrl({ project, screen: "changes", ref: change }), { replace: true });
	};
	const move = (delta: number) => {
		const index = changes.findIndex((item) => item.key === key);
		const item = changes[Math.max(0, Math.min(changes.length - 1, index + delta))];
		if (item) choose(item.key);
	};
	useBindings([
		{ key: "j", label: "Next change", when: () => !overlayOpen, handler: () => move(1) },
		{ key: "k", label: "Previous change", when: () => !overlayOpen, handler: () => move(-1) },
		{
			key: "enter",
			label: "Open blocking question",
			when: () => !overlayOpen && Boolean(openData?.items[0]),
			handler: () => {
				const question = openData?.items[0];
				if (question) go(question.q);
			},
		},
	]);
	return (
		<>
			<section className="pane changes-pane" id="list">
				<div className="phead">
					<b>Changes</b>
					<span className="dim">Latest commit's verdict</span>
				</div>
				<div className="pane-scroll" role="listbox" aria-label="Changes">
					{changes.map((change) => (
						<ListRow key={change.key} selected={key === change.key} onClick={() => choose(change.key)}>
							<span className="ref">{change.key}</span>
							<span className="change-title">
								<b>{change.title ?? change.branch ?? change.key}</b>
								<span className="dim">{change.reason ?? "No evidence for the latest commit"}</span>
							</span>
							{change.state !== "open" && <span className="change-ended">{change.state}</span>}
							<span className={`change-verdict v-${change.verdict ?? "pending"}`}>{change.verdict ?? "pending"}</span>
						</ListRow>
					))}
					{!changes.length && (
						<EmptyState
							{...(!read.error && !read.isPending
								? { doc: { page: "report-results", label: "How to send a report" } }
								: {})}
						>
							{read.error?.message ??
								(read.isPending
									? "Reading changes…"
									: "No changes yet. Send a pipeline report with a branch or pull request.")}
						</EmptyState>
					)}
				</div>
			</section>
			<section className="pane changes-pane" id="detail">
				{key ? (
					<>
						<div className="phead">
							<span className="ref">{key}</span>
							<b className="change-title">{current?.title ?? current?.branch ?? "Change"}</b>
						</div>
						<div className="pane-scroll detail-body">
							<div className={`change-gate v-${gateData?.verdict ?? "pending"}`}>
								<span className="dim">Gate of {current?.head?.slice(0, 12) ?? "the latest commit"}</span>
								<h2>{gateData?.verdict ?? (gate.error ? "Gate unavailable" : "Reading gate…")}</h2>
								<p>{gateData?.reason ?? gate.error?.message}</p>
								{gateData?.stale && <p>The verdict awaits new evidence or a fresh decision.</p>}
							</div>
							{current && current.state !== "open" && (
								<p className="change-ended-note">
									{current.state === "merged" ? "Merged." : "Closed without merging."} The verdict above is the last one
									its commits had. A failure nobody explained is no longer asked about here: if it came with the change,
									the line fails and asks.
								</p>
							)}
							{gateData && (
								<div className="change-tally">
									{Object.entries(gateData.tally)
										.filter(([, count]) => count > 0)
										.map(([label, count]) => {
											const shows = standingOf(label);
											return shows ? (
												<button
													type="button"
													key={label}
													className={`s-${shows}`}
													onClick={() => {
														setStanding(shows);
														document.getElementById("change-results")?.scrollIntoView({ block: "start" });
													}}
												>
													{count} {RESULT_STANDING_LABELS[shows]}
												</button>
											) : (
												<span key={label}>
													{count} {label}
												</span>
											);
										})}
								</div>
							)}
							<SectionHeading>Open questions</SectionHeading>
							{open.error && <p role="status">{open.error.message}</p>}
							{openData?.items.map((q) => (
								<a
									className="change-question"
									key={q.q}
									href={refUrl({ project, ref: q.q })}
									onClick={(event) => {
										event.preventDefault();
										go(q.q);
									}}
								>
									<ProducerGlyph kind={q.producer} />
									<span className="ref">{q.q}</span>
									<span>{q.title}</span>
									{q.blocks.length > 0 && <span className="blk">blocks gate</span>}
								</a>
							))}
							{openData?.items.length === 0 && (
								<p className="dim">
									{current && current.state !== "open"
										? "Nothing is asked about a change that has ended."
										: "No open questions about this change."}
								</p>
							)}
							<SectionHeading>Settled and excused</SectionHeading>
							{settled.error && <p role="status">{settled.error.message}</p>}
							{settledData?.items.map((q) => (
								<div className="change-decision" key={q.q}>
									<a
										className="ref"
										href={refUrl({ project, ref: q.q })}
										onClick={(event) => {
											event.preventDefault();
											go(q.q);
										}}
									>
										{q.q}
									</a>
									<b>{ANSWER_LABELS[String(q.decision?.answer.is)] ?? String(q.decision?.answer.is)}</b>
									<span>{q.title}</span>
									<small className="dim">
										{q.decision?.rule ? `Rule ${q.decision.rule}` : q.decision?.by.join(", ")} ·{" "}
										{q.decision && age(q.decision.at)}
										{q.decision?.reason && ` · ${q.decision.reason}`}
									</small>
								</div>
							))}
							{settledData?.items.length === 0 && <p className="dim">No decisions on this change yet.</p>}
							<ChangeResults key={key} change={key} standing={standing} choose={setStanding} />
							<SectionHeading>Impact</SectionHeading>
							{impact.error && <p role="status">{impact.error.message}</p>}
							{impactData.success && (
								<>
									<p className="dim">
										{impactData.data.counts.cases} cases · {impactData.data.counts.unreviewed} unreviewed ·{" "}
										{impactData.data.counts.failing} failing
									</p>
									{impactData.data.cases.map((c) => (
										<a
											className="change-impact"
											key={c.id}
											href={refUrl({ project, ref: c.id })}
											onClick={(event) => {
												event.preventDefault();
												go(c.id);
											}}
										>
											<span className="ref">{c.id}</span>
											<span>
												<b>{c.title}</b>
												<small>
													{c.why
														.map((reason) =>
															reason.startsWith("test:")
																? `Test file ${reason.slice(5)}`
																: reason.startsWith("req:")
																	? `Requirement ${reason.slice(4)}`
																	: reason,
														)
														.join(" · ")}
													{c.last && ` · ${c.last}`}
												</small>
											</span>
											{c.reviewed && <span className="dim">reviewed by you</span>}
										</a>
									))}
									{!impactData.data.cases.length && <p className="dim">No linked cases touch these files.</p>}
									<SectionHeading>Uncovered files</SectionHeading>
									{impactData.data.uncovered.length ? (
										<ul className="change-files">
											{impactData.data.uncovered.map((file) => (
												<li key={file}>{file}</li>
											))}
										</ul>
									) : (
										<p className="dim">No uncovered files reported.</p>
									)}
								</>
							)}
						</div>
					</>
				) : (
					<EmptyState>Select a change to see its gate, decisions and affected cases.</EmptyState>
				)}
			</section>
		</>
	);
}
