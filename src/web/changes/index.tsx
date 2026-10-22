import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { MergeReceipt, MergeReceiptResult } from "../../core/changes.ts";
import { ANSWER_LABELS, fixedInText, fixedOnChangeText } from "../../core/kinds.ts";
import {
	RESULT_STANDING_LABELS,
	type ResultStanding,
	reasonBesideShards,
	ShardWait,
	Verdict,
} from "../../core/runs.ts";
import { call } from "../lib/api.ts";
import { queryKey, useQueryOp } from "../lib/data.ts";
import { useBindings } from "../lib/keys.ts";
import { navigate, refUrl, routeUrl } from "../lib/router.ts";
import { openRun } from "../runs/index.tsx";
import { Run } from "../runs/models.ts";
import { useApp } from "../ui/context.tsx";
import { age, EmptyState, ListRow, ProducerGlyph, SectionHeading } from "../ui/index.tsx";
import { GateReason, ShardWaits } from "../ui/shards.tsx";
import { ChangeResults, standingOf, webUrl } from "./results.tsx";
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
	waiting: z.array(ShardWait).optional(),
	landing: z
		.object({
			commit: z.string(),
			branch: z.string(),
			run: z.string().nullable(),
			verdict: Verdict,
			reason: z.string(),
			waiting: z.array(ShardWait).optional(),
		})
		.nullable(),
});
type Change = z.infer<typeof Change>;
const Impact = z.object({
	change: z.object({ head: z.string().nullable(), mergeReceipt: MergeReceipt.nullable() }),
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
	const { project, route } = useApp();
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
	const fixedHere = settledData?.items.filter((q) => q.decision?.fixedIn?.change === key).length ?? 0;
	const address = webUrl(current?.url ?? null);
	const link = address ? { href: address, text: shownAddress(address) } : null;
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
		{ key: "j", label: "Next change", handler: () => move(1) },
		{ key: "k", label: "Previous change", handler: () => move(-1) },
		{
			key: "enter",
			label: "Open blocking question",
			applies: () => Boolean(openData?.items[0]),
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
					<span className="dim">Each head's verdict</span>
				</div>
				<div className="pane-scroll" role="listbox" aria-label="Changes">
					{changes.map((change) => (
						<ListRow key={change.key} selected={key === change.key} onClick={() => choose(change.key)}>
							<span className="ref">{change.key}</span>
							<span className="change-title">
								<b>{change.title ?? change.branch ?? change.key}</b>
								<span className="dim">
									{change.reason ? (
										<GateReason reason={change.reason} waiting={change.waiting} compact />
									) : (
										"No evidence for the latest commit"
									)}
								</span>
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
							{link && (
								// The address comes from a report, so it is shown as itself, never behind the change's key.
								<a className="change-link" href={link.href} target="_blank" rel="noreferrer noopener">
									{link.text}
								</a>
							)}
						</div>
						<div className="pane-scroll detail-body">
							<div className={`change-gate v-${gateData?.verdict ?? "pending"}`}>
								<span className="dim">Gate of the head{current?.head ? `, ${current.head.slice(0, 12)}` : ""}</span>
								<h2>{gateData?.verdict ?? (gate.error ? "Gate unavailable" : "Reading gate…")}</h2>
								<p>
									{gateData ? <GateReason reason={gateData.reason} waiting={gateData.waiting} /> : gate.error?.message}
								</p>
								{gateData?.stale && <p>The verdict awaits new evidence or a fresh decision.</p>}
							</div>
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
							{current?.state === "merged" && impactData.success && impactData.data.change.head === current.head && (
								<MergeGateReceipt receipt={impactData.data.change.mergeReceipt} />
							)}
							{current && <ChangeEnding change={current} />}
							{current && fixedHere > 0 && <p className="change-ended-note">{fixedOnChangeText(fixedHere)}</p>}
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
							{settledData?.items.map((q) => {
								const decision = q.decision?.supersedes ?? q.decision;
								return (
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
										<b>{ANSWER_LABELS[String(decision?.answer.is)] ?? String(decision?.answer.is)}</b>
										<span>{q.title}</span>
										<small className="dim">
											{decision?.rule ? `Rule ${decision.rule}` : decision?.by.join(", ")} ·{" "}
											{decision && age(decision.at)}
											{decision?.reason && ` · ${decision.reason}`}
										</small>
										{q.decision?.supersedes && (
											<small>
												{q.decision.fixedIn
													? fixedInText(q.decision.fixedIn)
													: `Ended by ${q.decision.rule ? `rule ${q.decision.rule}` : q.decision.by.join(", ")}`}
												{q.decision.reason && ` · ${q.decision.reason}`}
											</small>
										)}
									</div>
								);
							})}
							{settledData?.items.length === 0 && <p className="dim">No decisions on this change yet.</p>}
							<ChangeResults key={key} of={{ change: key }} standing={standing} choose={setStanding} />
							<ChangeRuns key={`runs:${key}`} change={key} />
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

function MergeGateReceipt({ receipt }: { receipt: MergeReceipt | null }) {
	const { project } = useApp();
	const [expanded, setExpanded] = useState(false);
	const input = { in: "receipt-results" as const, receipt: receipt?.id, limit: 50 };
	const pages = useInfiniteQuery({
		queryKey: queryKey({ project, op: "find", input }),
		enabled: expanded && receipt !== null,
		initialPageParam: "",
		queryFn: ({ pageParam, signal }) =>
			call("find", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }, { project, signal }),
		getNextPageParam: (page) => page.cursor ?? undefined,
	});
	if (!receipt) return <p className="change-ended-note">No gate receipt was recorded when this merge was reported.</p>;
	const rows = pages.data?.pages.flatMap((page) => page.items.map((row) => MergeReceiptResult.parse(row))) ?? [];
	return (
		<section className={`change-merge-receipt v-${receipt.gate.verdict}`} aria-label="Gate when the merge was reported">
			<span className="dim">Head {receipt.head?.slice(0, 12) ?? "not reported"} when the merge was reported</span>
			<b className="change-verdict">{receipt.gate.verdict}</b>
			<p>{receipt.gate.reason}</p>
			<time dateTime={new Date(receipt.at).toISOString()}>{new Date(receipt.at).toLocaleString()}</time>
			<details onToggle={(event) => setExpanded(event.currentTarget.open)}>
				<summary>Counted results</summary>
				<p className="dim">
					{receipt.count} {receipt.count === 1 ? "result" : "results"} counted at that time.
				</p>
				{receipt.count === 0 && <p>No results counted at that time.</p>}
				{pages.isPending && expanded && <p>Reading counted results…</p>}
				{pages.error && <p role="alert">{pages.error.message}</p>}
				{rows.map((row) => (
					<div className="change-receipt-result" key={`${row.result}:${row.method}:${row.job}:${row.env}`}>
						<span className={`s-${row.standing}`}>{RESULT_STANDING_LABELS[row.standing]}</span>
						<span>
							{row.name}
							<small className="dim">
								{row.test} · result {row.result} · {row.method} · {row.job}
								{row.env ? ` · ${row.env}` : ""}
							</small>
						</span>
						{row.decision !== null && (
							<span>
								Decision {row.decision}:{" "}
								{row.decisionAnswer ? (ANSWER_LABELS[row.decisionAnswer] ?? row.decisionAnswer) : "recorded"}
							</span>
						)}
					</div>
				))}
				{pages.hasNextPage && (
					<button type="button" disabled={pages.isFetchingNextPage} onClick={() => pages.fetchNextPage()}>
						More counted results
					</button>
				)}
			</details>
		</section>
	);
}

/** An address as a reader should see it before following it: its host and path. */
function shownAddress(address: string): string {
	const url = new URL(address);
	return `${url.host}${url.pathname.replace(/\/$/, "")}`;
}

/** How a change ended, naming which commit each gate on the page is about. An open change says nothing here. */
function ChangeEnding({ change }: { change: Change }) {
	const { project } = useApp();
	if (change.state === "open") return null;
	if (change.state === "closed") return <p className="change-ended-note">Closed without merging.</p>;
	const landing = change.landing;
	if (!landing) return <p className="change-ended-note">Merged. No commit on a trunk branch was reported for it.</p>;
	if (landing.commit === change.head)
		return (
			<p className="change-ended-note">
				Merged as its head. That commit is on {landing.branch} now, so {landing.branch}'s decisions judge the gate
				above.
			</p>
		);
	return (
		<div className="change-landing">
			<p className="change-ended-note">
				Merged. It landed on {landing.branch} as another commit, which has a gate of its own.
			</p>
			<div className={`change-landing-gate v-${landing.verdict}`}>
				<span className="dim">
					Gate of <span className="mono">{landing.commit.slice(0, 12)}</span> on {landing.branch}
				</span>
				<b className="change-verdict">{landing.verdict}</b>
				{landing.run ? (
					<a
						href={routeUrl({ project, screen: "runs", ref: landing.run })}
						onClick={(event) => {
							event.preventDefault();
							if (landing.run) navigate(routeUrl({ project, screen: "runs", ref: landing.run }));
						}}
					>
						{reasonBesideShards(landing.reason, landing.waiting)}
					</a>
				) : (
					<span>{reasonBesideShards(landing.reason, landing.waiting)}</span>
				)}
				{/* The landing has no row to open for its shards, so they are drawn here in full. */}
				<ShardWaits waiting={landing.waiting ?? []} />
			</div>
		</div>
	);
}

/** The change's runs, one for each commit reported on it, newest first: how its verdict moved from push to push. */
function ChangeRuns({ change }: { change: string }) {
	const { project } = useApp();
	const input = { in: "runs", change, limit: 100 } satisfies Parameters<typeof call<"find">>[1];
	const read = useInfiniteQuery({
		queryKey: [...queryKey({ project, op: "find", input }), "pages"],
		initialPageParam: "",
		queryFn: ({ pageParam, signal }) =>
			call("find", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }, { project, signal }),
		getNextPageParam: (page) => page.cursor ?? undefined,
	});
	const parsed = Run.array().safeParse(read.data?.pages.flatMap((page) => page.items));
	const runs = parsed.success ? parsed.data : [];
	return (
		<>
			<SectionHeading>Runs, newest first</SectionHeading>
			{read.error && <p role="status">{read.error.message}</p>}
			<ul className="change-runs" aria-label="Runs of this change">
				{runs.map((run) => (
					<li key={run.ref}>
						<a
							href={routeUrl({ project, screen: "runs", ref: run.ref })}
							onClick={(event) => {
								event.preventDefault();
								openRun(project, run);
							}}
						>
							<span className="ref">{run.ref}</span>
							<span>
								{run.location?.label ?? run.name}{" "}
								{"commit" in run.accepts && <small className="mono dim">{run.accepts.commit.slice(0, 12)}</small>}
							</span>
							<span className={`change-verdict v-${run.verdict}`}>{run.verdict}</span>
							<span className="change-run-reason dim">
								<GateReason reason={run.reason} waiting={run.waiting} compact />
							</span>
							<time dateTime={new Date(run.createdAt).toISOString()} title={new Date(run.createdAt).toLocaleString()}>
								{age(run.createdAt)}
							</time>
						</a>
					</li>
				))}
			</ul>
			{read.hasNextPage && (
				<button type="button" className="change-results-more" onClick={() => void read.fetchNextPage()}>
					More runs
				</button>
			)}
			{!read.isPending && !read.error && runs.length === 0 && (
				<p className="dim">No commit of this change has been reported yet.</p>
			)}
		</>
	);
}
