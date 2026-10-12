import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { Api } from "../../core/api.ts";
import { ANSWER_HELP, ANSWER_KEYS, ANSWER_LABELS, ANSWERS, KINDS, type Kind } from "../../core/kinds.ts";
import type { InboxReply, QuestionItem } from "../../core/ops.ts";
import { call } from "../lib/api.ts";
import { invalidateProject, queryClient, queryKey, useQueryOp } from "../lib/data.ts";
import { deviceKey } from "../lib/device.ts";
import { randomId } from "../lib/ids.ts";
import { type Binding, useBindings } from "../lib/keys.ts";
import { navigate, routeUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { age, EmptyState, KeyCap, ListRow, ProducerGlyph } from "../ui/index.tsx";
import { FindingEvidence, MapEvidence, QuestionEvidence } from "./evidence.tsx";
import "./queue.css";

const kindLabels: Record<Kind, string> = {
	adopt: "Proposals",
	map: "Unlinked",
	failure: "Failures",
	finding: "Findings",
	signoff: "Sign-offs",
};
const kindNames: Record<Kind, string> = {
	adopt: "proposal",
	map: "unlinked",
	failure: "failure",
	finding: "finding",
	signoff: "sign-off",
};
type DecisionEntry = { question: QuestionItem; answer: Record<string, unknown> };
type LastAnswer = { entries: DecisionEntry[]; confirmed: Promise<boolean> };
type InlineAnswer = { entries: DecisionEntry[]; field: "ref" | "reason"; value: string };

export function QueueScreen() {
	const { project } = useApp();
	return <QueueWorkbench key={project} />;
}

function QueueWorkbench() {
	const { project, route, overlayOpen, openPalette, setStatus } = useApp();
	const [state, setState] = useState<"open" | "decided">("open");
	const [kind, setKind] = useState<Kind | null>(null);
	const [cursor, setCursor] = useState<string | null>(route.ref);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [hidden, setHidden] = useState<Set<string>>(new Set());
	const [restored, setRestored] = useState<QuestionItem[]>([]);
	const [rules, setRules] = useState(false);
	const [full, setFull] = useState(false);
	const [last, setLast] = useState<LastAnswer | null>(null);
	const [lastMessage, setLastMessage] = useState("One key answers. Every decision stays in the ledger.");
	const [inline, setInline] = useState<InlineAnswer | null>(null);
	const inlineRef = useRef<HTMLInputElement>(null);
	const extraInputs = useRef(new Map<string, string>());
	const actionNo = useRef(0);
	const undoing = useRef(new Set<string>());
	const pendingAnswers = useRef(new Set<string>());
	const seenRoute = useRef<string | null>(null);
	useEffect(() => {
		setStatus("One key answers. Every decision stays in the ledger; u withdraws an answer.");
	}, [setStatus]);
	const routeQuestion = useQueryOp({
		project,
		op: "get",
		input: { refs: [route.ref ?? ""] },
		enabled: Boolean(route.ref),
	});
	const routeState = z
		.object({ q: z.string(), state: z.enum(["open", "decided", "dissolved"]) })
		.safeParse(routeQuestion.data?.[0]);
	const routeQuestionRef = routeState.success ? routeState.data.q : null;
	const routeQuestionState = routeState.success ? routeState.data.state : null;
	useEffect(() => {
		if (route.ref && routeQuestionRef === route.ref && seenRoute.current !== route.ref) {
			seenRoute.current = route.ref;
			if (routeQuestionState === "decided") setState("decided");
		}
	}, [route.ref, routeQuestionRef, routeQuestionState]);
	const input: Api["inbox"]["input"] = { state, ...(kind ? { kind } : {}), limit: 100 };
	const cacheKey = [...queryKey({ project, op: "inbox", input }), "pages"];
	const inbox = useInfiniteQuery({
		queryKey: cacheKey,
		initialPageParam: "",
		queryFn: async ({ pageParam, signal }) => {
			const reply = await call("inbox", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }, { project, signal });
			setRestored((previous) => {
				const next = previous.filter((question) => {
					if (
						pendingAnswers.current.has(question.q) ||
						undoing.current.has(question.q) ||
						question.state !== input.state ||
						(input.kind && question.kind !== input.kind)
					)
						return true;
					return !reply.items.some((item) => item.q === question.q) && Boolean(pageParam || reply.cursor);
				});
				return next.length === previous.length ? previous : next;
			});
			return reply;
		},
		getNextPageParam: (page) => page.cursor ?? undefined,
	});
	const fetched = inbox.data?.pages.flatMap((page) => page.items) ?? [];
	const merged = [...restored.filter((item) => !fetched.some((q) => q.q === item.q)), ...fetched];
	const items = merged.filter(
		(item) =>
			item.state === state &&
			(!kind || item.kind === kind) &&
			(state !== "open" || !hidden.has(item.q)) &&
			(rules || item.kind !== "map" || !item.decision?.rule),
	);
	const current = items.find((item) => item.q === cursor) ?? items[0];
	const counts = inbox.data?.pages[0]?.counts ?? {};
	useEffect(() => {
		setCursor(route.ref);
	}, [route.ref]);
	useEffect(() => {
		if (inline) inlineRef.current?.focus();
	}, [inline]);
	useEffect(() => {
		if (current?.q) document.querySelector(`[data-question="${current.q}"]`)?.scrollIntoView({ block: "nearest" });
	}, [current?.q]);
	useEffect(() => {
		if (route.ref && !fetched.some((item) => item.q === route.ref) && inbox.hasNextPage && !inbox.isFetchingNextPage)
			void inbox.fetchNextPage();
	}, [route.ref, fetched, inbox.hasNextPage, inbox.isFetchingNextPage, inbox.fetchNextPage]);

	function patchRemoved(entries: DecisionEntry[]): void {
		const refs = new Set(entries.map((entry) => entry.question.q));
		queryClient.setQueryData<InfiniteData<InboxReply>>(
			cacheKey,
			(previous) =>
				previous && {
					...previous,
					pages: previous.pages.map((page) => ({ ...page, items: page.items.filter((item) => !refs.has(item.q)) })),
				},
		);
		queryClient.setQueriesData<InboxReply>(
			{
				predicate: (query) =>
					query.queryKey[0] === project && query.queryKey[1] === "inbox" && query.queryKey.length === 3,
			},
			(previous) => {
				if (!previous) return previous;
				const counts: Record<string, number> = {
					...previous.counts,
					open: Math.max(0, (previous.counts.open ?? 0) - entries.length),
				};
				for (const entry of entries) counts[entry.question.kind] = Math.max(0, (counts[entry.question.kind] ?? 0) - 1);
				return { ...previous, counts, items: previous.items.filter((item) => !refs.has(item.q)) };
			},
		);
	}
	function bringBack(questions: QuestionItem[], select = true): void {
		setHidden((previous) => {
			const next = new Set(previous);
			for (const q of questions) next.delete(q.q);
			return next;
		});
		setRestored((previous) => [...questions, ...previous.filter((item) => !questions.some((q) => q.q === item.q))]);
		if (select) setCursor(questions[0]?.q ?? null);
	}
	function extraKey(entry: DecisionEntry, field: InlineAnswer["field"]): string {
		return deviceKey("queue-input", `${project}:${entry.question.q}:${String(entry.answer.is)}:${field}`);
	}
	function readExtra(entry: DecisionEntry, field: InlineAnswer["field"]): string {
		const key = extraKey(entry, field);
		const value = extraInputs.current.get(key);
		if (value !== undefined) return value;
		try {
			return localStorage.getItem(key) ?? "";
		} catch {
			return "";
		}
	}
	function startInline(entries: DecisionEntry[], field: InlineAnswer["field"]): void {
		const first = entries[0];
		setInline({ entries, field, value: first ? readExtra(first, field) : "" });
		if (current) navigate(routeUrl({ project, screen: "queue", ref: current.q }), { replace: true });
	}
	function rememberInline(next: InlineAnswer): void {
		setInline(next);
		for (const entry of next.entries) {
			const key = extraKey(entry, next.field);
			extraInputs.current.set(key, next.value);
			try {
				localStorage.setItem(key, next.value);
			} catch {
				setStatus("Device storage is full. Your answer text is kept in this tab.");
			}
		}
	}
	function clearExtra(entry: DecisionEntry, sent: InlineAnswer): void {
		const key = extraKey(entry, sent.field);
		if (readExtra(entry, sent.field) !== sent.value) return;
		extraInputs.current.delete(key);
		try {
			if (localStorage.getItem(key) === sent.value) localStorage.removeItem(key);
		} catch {}
	}
	function submit(entries: DecisionEntry[], reason?: string, extra?: InlineAnswer): void {
		if (!entries.length) return;
		const action = ++actionNo.current;
		const refs = new Set(entries.map((entry) => entry.question.q));
		for (const ref of refs) pendingAnswers.current.add(ref);
		const index = items.findIndex((item) => item.q === current?.q);
		const next = items.slice(index + 1).find((item) => !refs.has(item.q)) ?? items.find((item) => !refs.has(item.q));
		setHidden((previous) => new Set([...previous, ...refs]));
		setRestored((previous) => previous.filter((question) => !refs.has(question.q)));
		setCursor(next?.q ?? null);
		setSelected(new Set());
		setInline(null);
		void queryClient.cancelQueries({ queryKey: cacheKey });
		patchRemoved(entries);
		const text = `${entries.map((entry) => entry.question.q).join(", ")} · ${ANSWER_LABELS[String(entries[0]?.answer.is)] ?? entries[0]?.answer.is}`;
		setLastMessage(`${text} · recording`);
		setStatus(
			`${text}. ${entries.some((entry) => entry.question.kind === "adopt") ? "The adopted version stays in history." : "u withdraws the decision."}`,
		);
		const all = entries.map(({ question, answer }) => ({
			q: question.q,
			onEvidence: question.evidenceHash,
			answer,
			...(reason ? { reason } : {}),
		}));
		const one = all[0];
		if (!one) return;
		const confirmed = call("decide", all.length === 1 ? { ...one, cmd: randomId() } : { all, cmd: randomId() }, {
			project,
		})
			.then(async (replies) => {
				for (const ref of refs) pendingAnswers.current.delete(ref);
				if (extra)
					for (const entry of entries)
						if (
							replies.some(
								(reply) => reply.q === entry.question.q && (reply.status === "decided" || reply.status === "already"),
							)
						)
							clearExtra(entry, extra);
				const rejected = entries.filter(
					(entry) =>
						!replies.some(
							(reply) => reply.q === entry.question.q && (reply.status === "decided" || reply.status === "already"),
						),
				);
				if (rejected.length) {
					bringBack(
						rejected.map((entry) => entry.question),
						false,
					);
					const reply = replies.find((reply) => rejected.some((entry) => entry.question.q === reply.q));
					const message =
						reply?.status === "conflict"
							? `The evidence changed. ${reply.needs ?? "Read the new evidence before answering."}`
							: reply?.status === "advised"
								? `Advice recorded. Needs ${reply.needs ?? rejected[0]?.question.needs}.`
								: `Answer not recorded. Needs ${reply?.needs ?? rejected[0]?.question.needs}.`;
					if (action === actionNo.current) {
						setLastMessage(message);
						setStatus(message);
						setLast(null);
					}
					await invalidateProject(project);
					const fresh = await call("inbox", { state: "open", limit: 500 }, { project });
					setRestored((previous) => previous.map((item) => fresh.items.find((q) => q.q === item.q) ?? item));
					return false;
				}
				if (action === actionNo.current) setLastMessage(`${text} · recorded`);
				await invalidateProject(project);
				setHidden((previous) => {
					const next = new Set(previous);
					for (const ref of refs) next.delete(ref);
					return next;
				});
				return true;
			})
			.catch((error: unknown) => {
				for (const ref of refs) pendingAnswers.current.delete(ref);
				bringBack(
					entries.map((entry) => entry.question),
					false,
				);
				const message = error instanceof Error ? error.message : "The answer could not be recorded. Try again.";
				if (action === actionNo.current) {
					setLastMessage(message);
					setStatus(message);
					setLast(null);
				}
				void invalidateProject(project);
				return false;
			});
		setLast({ entries, confirmed });
	}
	function answer(is: string, suggested?: Record<string, unknown>): void {
		if (!current || state !== "open" || current.you === "forbidden" || inline) return;
		if (current.answers && !current.answers.includes(is)) {
			setStatus("This answer does not apply to the current evidence.");
			return;
		}
		const questions = selected.size ? items.filter((item) => selected.has(item.q)) : [current];
		if (
			questions.some((q) => q.kind !== current.kind || q.you === "forbidden" || (q.answers && !q.answers.includes(is)))
		) {
			setStatus("Select questions of one kind that you may answer.");
			return;
		}
		if (is === "link" && !suggested) {
			if (questions.length !== 1) {
				setStatus("Link one question at a time so each test can have its own case.");
				return;
			}
			const parsed = MapEvidence.safeParse(current.evidence);
			if (!parsed.success || !parsed.data.tests.length) {
				setStatus("No tests can be linked from this evidence.");
				return;
			}
			const question = current;
			const tests = parsed.data.tests;
			const pick = (index: number, pairs: [string, string][]) => {
				const test = tests[index];
				if (!test) {
					submit([{ question, answer: { is: "link", pairs } }]);
					return;
				}
				openPalette({
					title: `Link ${test.t}: ${test.name}`,
					onPickCase: (ref) => pick(index + 1, [...pairs, [test.t, ref]]),
				});
			};
			pick(0, []);
			return;
		}
		const finding = FindingEvidence.safeParse(current.evidence);
		const parsed = ANSWERS[current.kind].safeParse(
			suggested ?? {
				is,
				...(current.kind === "finding" && is === "accept"
					? { apply: finding.success && finding.data.suggest !== null }
					: {}),
			},
		);
		if (!parsed.success) {
			setStatus("That suggestion needs more information. Choose an answer beside the evidence.");
			return;
		}
		const entries = questions.map((question) => {
			const suggestion = FindingEvidence.safeParse(question.evidence);
			return {
				question,
				answer:
					question.kind === "finding" && parsed.data.is === "accept"
						? { ...parsed.data, apply: suggestion.success && suggestion.data.suggest !== null }
						: parsed.data,
			};
		});
		if (questions.some((q) => q.needs.includes("with a reason"))) {
			startInline(entries, "reason");
			return;
		}
		if (is === "defect") {
			startInline(entries, "ref");
			return;
		}
		submit(entries);
	}
	function undo(questions = last?.entries.map((entry) => entry.question) ?? []): void {
		questions = questions.filter((question) => !undoing.current.has(question.q));
		if (!questions.length) return;
		if (questions.some((question) => question.kind === "adopt")) {
			setStatus("An adopted edit stays in history. Restore the earlier case version to undo it.");
			setLastMessage(
				"Proposal decisions cannot be withdrawn. To reverse an adopted edit, restore an earlier version in the case pane.",
			);
			return;
		}
		const prior = state === "decided" ? null : last;
		for (const question of questions) undoing.current.add(question.q);
		setLast(null);
		const reopened = new Set<string>();
		const action = ++actionNo.current;
		bringBack(questions.map((q) => ({ ...q, state: "open", decision: null })));
		setState("open");
		setLastMessage(`${questions.map((q) => q.q).join(", ")} · withdrawing the answer`);
		void (async () => {
			if (prior && !(await prior.confirmed)) return;
			for (const question of questions) {
				const replies = await call("decide", { undo: question.q, cmd: randomId() }, { project });
				const reply = replies[0];
				if (reply?.status !== "reopened") {
					const current = z
						.object({ q: z.string(), state: z.string() })
						.parse((await call("get", { refs: [question.q] }, { project }))[0]);
					if (current.state !== "open") throw new Error(reply?.needs ?? "The decision could not be withdrawn.");
				}
				reopened.add(question.q);
			}
			if (action === actionNo.current) {
				setLast(null);
				setLastMessage("Answer withdrawn. Both decisions stay in the ledger.");
				setStatus("Answer withdrawn. Both decisions stay in the ledger.");
			}
			await invalidateProject(project);
			const cached = queryClient.getQueryData<InfiniteData<InboxReply>>([
				...queryKey({ project, op: "inbox", input: { state: "open", ...(kind ? { kind } : {}), limit: 100 } }),
				"pages",
			]);
			setRestored((previous) =>
				previous.filter(
					(question) =>
						!reopened.has(question.q) ||
						!cached?.pages.some((page) => page.items.some((item) => item.q === question.q)),
				),
			);
		})()
			.catch((error: unknown) => {
				const unconfirmed = new Set(
					questions.filter((question) => !reopened.has(question.q)).map((question) => question.q),
				);
				setRestored((previous) => previous.filter((q) => !unconfirmed.has(q.q)));
				setHidden((previous) => {
					const next = new Set(previous);
					for (const question of questions) next.delete(question.q);
					return next;
				});
				queryClient.setQueriesData<InfiniteData<InboxReply>>(
					{
						predicate: (query) =>
							query.queryKey[0] === project &&
							query.queryKey[1] === "inbox" &&
							query.queryKey[3] === "pages" &&
							z.object({ state: z.string() }).safeParse(query.queryKey[2]).data?.state === "open",
					},
					(previous) =>
						previous && {
							...previous,
							pages: previous.pages.map((page) => ({
								...page,
								items: page.items.filter((q) => !unconfirmed.has(q.q)),
							})),
						},
				);
				const message = error instanceof Error ? error.message : "The decision could not be withdrawn.";
				setLastMessage(message);
				setStatus(message);
				void invalidateProject(project);
			})
			.finally(() => {
				for (const question of questions) undoing.current.delete(question.q);
			});
	}
	function move(delta: number): void {
		const index = items.findIndex((item) => item.q === current?.q);
		const item = items[Math.max(0, Math.min(items.length - 1, index + delta))];
		if (item) {
			setCursor(item.q);
			navigate(routeUrl({ project, screen: "queue", ref: item.q }), { replace: true });
		}
	}
	const active = () => !overlayOpen && !inline;
	const keys: Binding[] = [
		{ key: "j", label: "Next question", handler: () => move(1), when: active },
		{ key: "k", label: "Previous question", handler: () => move(-1), when: active },
		{ key: "arrowdown", label: "Next question", handler: () => move(1), when: active, hidden: true },
		{ key: "arrowup", label: "Previous question", handler: () => move(-1), when: active, hidden: true },
		{ key: "space", label: "All evidence", handler: () => setFull((value) => !value), when: active },
		{
			key: "x",
			label: "Select question",
			when: () => active() && state === "open",
			handler: () => {
				if (!current) return;
				setSelected((previous) => {
					const next = new Set(previous);
					if (next.has(current.q)) next.delete(current.q);
					else if (items.some((q) => next.has(q.q) && q.kind !== current.kind))
						setStatus("Bulk answers require one question kind.");
					else next.add(current.q);
					return next;
				});
			},
		},
		...Object.entries(current ? ANSWER_KEYS[current.kind] : {}).map(([key, is]) => ({
			key,
			label: ANSWER_LABELS[is] ?? is,
			handler: () => answer(is),
			when: () =>
				active() &&
				state === "open" &&
				current?.you !== "forbidden" &&
				(!current?.answers || current.answers.includes(is)),
		})),
		{
			key: "enter",
			label: "Take advice",
			handler: () => {
				const suggestion = current?.advice.at(-1)?.answer;
				if (suggestion && typeof suggestion.is === "string") answer(suggestion.is, suggestion);
			},
			when: () => active() && state === "open" && Boolean(current?.advice.length) && current?.you !== "forbidden",
		},
		{
			key: "u",
			label: "Undo answer",
			handler: () => undo(state === "decided" && current ? [current] : undefined),
			when: () => active() && Boolean(last || current?.decision),
		},
	];
	useBindings(keys);
	const help: Readonly<Record<string, string>> = current ? ANSWER_HELP[current.kind] : {};
	return (
		<>
			<section className="pane queue-pane" id="list">
				<div className="phead">
					<b>Queue</b>
					<span className="dim">{counts.open ?? 0} need an answer</span>
					<div className="queue-state">
						<button
							type="button"
							aria-pressed={state === "open"}
							onClick={() => {
								setState("open");
								setCursor(null);
								setSelected(new Set());
							}}
						>
							Open
						</button>
						<button
							type="button"
							aria-pressed={state === "decided"}
							onClick={() => {
								setState("decided");
								setCursor(null);
								setSelected(new Set());
							}}
						>
							Settled
						</button>
					</div>
				</div>
				<nav className="queue-tabs" aria-label="Question kind">
					<button
						type="button"
						aria-pressed={kind === null}
						onClick={() => {
							setKind(null);
							setCursor(null);
							setSelected(new Set());
						}}
					>
						All
					</button>
					{KINDS.map((value) => (
						<button
							type="button"
							key={value}
							aria-pressed={kind === value}
							onClick={() => {
								setKind(value);
								setCursor(null);
								setSelected(new Set());
							}}
						>
							{kindLabels[value]} <span>{counts[value] ?? 0}</span>
						</button>
					))}
				</nav>
				{state === "decided" && (
					<label className="queue-rules">
						<input type="checkbox" checked={rules} onChange={(event) => setRules(event.target.checked)} /> Show unlinked
						tests decided by rules
					</label>
				)}
				<div className="pane-scroll" role="listbox" aria-label="Questions" aria-multiselectable="true">
					{items.map((question) => (
						<div data-question={question.q} key={question.q}>
							<ListRow
								selected={current?.q === question.q || selected.has(question.q)}
								onClick={() => {
									setCursor(question.q);
									navigate(routeUrl({ project, screen: "queue", ref: question.q }), { replace: true });
								}}
							>
								<span className="queue-select">{selected.has(question.q) ? "✓" : ""}</span>
								<ProducerGlyph kind={question.producer} />
								<span className="ref">{question.q}</span>
								<span className={`kind k-${question.kind}`}>{kindNames[question.kind]}</span>
								<span className="queue-title">{question.title}</span>
								<span className="queue-case ref">{question.about.find((ref) => ref.startsWith("C-"))}</span>
								{question.blocks.length > 0 && <span className="blk">blocks gate</span>}
								<span className="queue-age">{age(question.openedAt)}</span>
							</ListRow>
						</div>
					))}
					{inbox.error && (
						<p className="queue-read-error" role="status">
							{inbox.error.message}{" "}
							<button type="button" onClick={() => void inbox.refetch()}>
								Retry
							</button>
						</p>
					)}
					{items.length === 0 && (
						<EmptyState>
							{inbox.isPending
								? "Reading questions…"
								: state === "open"
									? "The queue is clear. New evidence appears here."
									: "No settled questions in this view."}
						</EmptyState>
					)}
					{inbox.hasNextPage && (
						<button className="queue-more" type="button" onClick={() => void inbox.fetchNextPage()}>
							More questions
						</button>
					)}
				</div>
			</section>
			<section className="pane queue-pane" id="detail">
				{current ? (
					<>
						<div className="queue-heading">
							<div className="queue-meta">
								<span className="ref" data-current-question={current.q}>
									{current.q}
								</span>
								<span className={`kind k-${current.kind}`}>{kindNames[current.kind]}</span>
								<ProducerGlyph kind={current.producer} />
								<span className="dim">{age(current.openedAt)}</span>
								{current.blocks.length > 0 && <span className="blk">blocks {current.blocks.join(", ")}</span>}
							</div>
							<h2>{current.title}</h2>
						</div>
						<div className="pane-scroll queue-evidence" key={current.q}>
							<div className="sech">
								Evidence{" "}
								<button type="button" className="r" onClick={() => setFull((value) => !value)}>
									<KeyCap>space</KeyCap> {full ? "less" : "all of it"}
								</button>
							</div>
							<QuestionEvidence question={current} full={full} />
							{current.seen.carried > 0 && (
								<p className="hintbox">
									An earlier answer carried to {current.seen.carried} occurrences. This evidence is awaiting a fresh
									decision.
								</p>
							)}
							{current.advice.map((advice) => (
								<div className="hintbox" key={`${advice.by}:${JSON.stringify(advice.answer)}:${advice.reason}`}>
									<ProducerGlyph kind={advice.kind} /> {advice.by} suggests {String(advice.answer.is)}
									{advice.reason && `: ${advice.reason}`} <KeyCap>Enter</KeyCap> takes the suggestion.
								</div>
							))}
							{state === "decided" && current.decision && (
								<div className="ev">
									<b>{ANSWER_LABELS[String(current.decision.answer.is)] ?? String(current.decision.answer.is)}</b>
									<p>
										{current.decision.rule
											? `Decided by rule ${current.decision.rule}`
											: `Decided by ${current.decision.by.join(", ")}`}{" "}
										· {age(current.decision.at)}
									</p>
									{current.decision.reason && <p>{current.decision.reason}</p>}
									<button className="out" type="button" onClick={() => undo([current])}>
										<KeyCap>u</KeyCap> Withdraw answer
									</button>
								</div>
							)}
						</div>
						{state === "open" && (
							<div className="queue-answers">
								<div className="queue-needs">
									{current.you === "forbidden"
										? `You cannot settle this. Needs ${current.needs}.`
										: current.you === "advice"
											? `Your answer is advice. Needs ${current.needs}.`
											: selected.size
												? `${selected.size} selected questions will receive this answer.`
												: `Needs ${current.needs}.`}
								</div>
								{Object.entries(ANSWER_KEYS[current.kind]).map(([key, is]) => (
									<button
										className="ans"
										type="button"
										key={key}
										disabled={
											current.you === "forbidden" ||
											Boolean(inline) ||
											(current.answers && !current.answers.includes(is))
										}
										title={
											current.answers && !current.answers.includes(is)
												? "This answer does not apply to the current evidence."
												: undefined
										}
										onClick={() => answer(is)}
									>
										<KeyCap>{key}</KeyCap>
										<b>{ANSWER_LABELS[is]}</b>
										<span>{help[is]}</span>
									</button>
								))}
							</div>
						)}
					</>
				) : (
					<EmptyState>Select a question to read its evidence and answer keys.</EmptyState>
				)}
				{inline && (
					<form
						className="queue-inline"
						onSubmit={(event) => {
							event.preventDefault();
							if (inline.field === "reason" && !inline.value.trim()) return;
							submit(
								inline.entries.map((entry) => ({
									...entry,
									answer:
										inline.field === "ref" && inline.value.trim()
											? { ...entry.answer, ref: inline.value.trim() }
											: entry.answer,
								})),
								inline.field === "reason" ? inline.value.trim() : undefined,
								inline,
							);
						}}
					>
						<label htmlFor="answer-extra">
							{inline.field === "ref" ? "Defect reference, optional" : "Reason required by policy"}
						</label>
						<input
							className="form-input"
							id="answer-extra"
							ref={inlineRef}
							value={inline.value}
							onChange={(event) => rememberInline({ ...inline, value: event.target.value })}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									event.preventDefault();
									if (inline.field === "ref") submit(inline.entries, undefined, inline);
									else setInline(null);
								}
							}}
						/>
						<span className="dim">
							Enter records · Escape {inline.field === "ref" ? "skips the reference" : "cancels"}
						</span>
					</form>
				)}
				<div className="queue-last" role="status" aria-live="polite">
					<span>{lastMessage}</span>
					{last && (
						<button type="button" onClick={() => undo()}>
							<KeyCap>u</KeyCap> undo
						</button>
					)}
				</div>
			</section>
		</>
	);
}
