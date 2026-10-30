import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { Api } from "../../core/api.ts";
import {
	ANSWER_HELP,
	ANSWER_KEYS,
	ANSWER_LABELS,
	ANSWERS,
	DECIDE_MAX,
	endingText,
	KIND_WORDS,
	KINDS,
	type Kind,
} from "../../core/kinds.ts";
import { whyWaiting, yourAnswerCounts } from "../../core/policy-guide.ts";
import { adoptHelpFor, ProposalTally } from "../../core/proposals.ts";
import { type InboxReply, QuestionItem } from "../../core/replies.ts";
import { stakes, waitingPhrase } from "../../core/stakes.ts";
import { call } from "../lib/api.ts";
import { invalidateProject, queryClient, queryKey, useQueryOp } from "../lib/data.ts";
import { deviceKey, deviceSession, sessionCurrent } from "../lib/device.ts";
import { randomId } from "../lib/ids.ts";
import { type Binding, useBindings } from "../lib/keys.ts";
import { answerShown } from "../lib/proposals.ts";
import { navigate, routeUrl } from "../lib/router.ts";
import { AnswerExtra } from "../ui/answer-extra.tsx";
import { useApp } from "../ui/context.tsx";
import { age, DocLink, EmptyState, KeyCap, ListRow, ProducerGlyph } from "../ui/index.tsx";
import {
	evidenceMessage,
	FindingEvidence,
	MapEvidence,
	QuestionEvidence,
	questionReadMessage,
	readOnScreen,
} from "./evidence.tsx";
import { Handoff } from "./handoff.tsx";
import {
	allOfKind,
	capped,
	counted,
	named,
	type Row,
	rangeOf,
	sharedAnswers,
	takes,
	whyNotSelectable,
} from "./selection.ts";
import { TrackerCreate } from "./tracker-create.tsx";
import "./queue.css";

type DecisionEntry = { question: QuestionItem; answer: Record<string, unknown> };
type Withdrawal = {
	question: QuestionItem;
	decision: number;
};
type LastAnswer = {
	entries: DecisionEntry[];
	confirmed: Promise<Withdrawal[]>;
	command?: Api["decide"]["input"] | undefined;
};
type QueuedAnswer = { is: string; suggested?: Record<string, unknown> | undefined; via: "key" | "button" };
type InlineAnswer = { entries: DecisionEntry[]; field: "ref" | "reason"; value: string } & (
	| { kind: "answer" }
	| { kind: "withdrawal"; prior: LastAnswer }
);

export function QueueScreen() {
	const { project } = useApp();
	return <QueueWorkbench key={project} />;
}

const READING = "Reading this question before answering. Your note is kept.";

function QueueWorkbench() {
	const { project, route, openPalette, setStatus, session } = useApp();
	const owner = useRef(deviceSession()).current;
	const writes = useRef(new Map<string, Promise<unknown>>());
	const refActions = useRef(new Map<string, number>());
	const shown = useRef(new Map<string, QuestionItem>());
	function ordered<T>(refs: string[], write: () => Promise<T>): Promise<T> {
		const prior = refs.map((ref) => writes.current.get(ref));
		const task = Promise.all(prior).then(() => {
			if (!sessionCurrent(owner)) throw new Error("The session changed. Your input is kept.");
			return write();
		});
		for (const ref of refs)
			writes.current.set(
				ref,
				task.catch(() => undefined),
			);
		return task;
	}
	const [state, setState] = useState<"open" | "decided">("open");
	const [kind, setKind] = useState<Kind | null>(null);
	const [cursor, setCursor] = useState<string | null>(route.ref);
	const cursorRef = useRef(cursor);
	cursorRef.current = cursor;
	const [selected, setSelected] = useState<Set<string>>(new Set());
	/** Where a range starts: the row whose box was clicked last. */
	const anchor = useRef<string | null>(null);
	const [hidden, setHidden] = useState<Set<string>>(new Set());
	const [restored, setRestored] = useState<QuestionItem[]>([]);
	const [rules, setRules] = useState(false);
	const [full, setFull] = useState(false);
	const [last, setLast] = useState<LastAnswer | null>(null);
	const [lastMessage, setLastMessage] = useState("One key answers. Every decision stays in the ledger.");
	const [inline, setInline] = useState<InlineAnswer | null>(null);
	const extraInputs = useRef(new Map<string, string>());
	const actionNo = useRef(0);
	const undoing = useRef(new Map<LastAnswer, { next: QueuedAnswer | null }>());
	const [readyAnswer, setReadyAnswer] = useState<{ q: string; input: QueuedAnswer } | null>(null);
	const isUndoing = (ref: string) =>
		[...undoing.current.keys()].some((answer) => answer.entries.some((entry) => entry.question.q === ref));
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
						isUndoing(question.q) ||
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
	const listedRouteQuestion =
		inbox.isFetchedAfterMount && !inbox.isError ? merged.find((item) => item.q === route.ref) : undefined;
	const routeQuestionRef = listedRouteQuestion?.q ?? (routeState.success ? routeState.data.q : null);
	const routeQuestionState = listedRouteQuestion?.state ?? (routeState.success ? routeState.data.state : null);
	useEffect(() => {
		if (route.ref && routeQuestionRef === route.ref && seenRoute.current !== route.ref) {
			seenRoute.current = route.ref;
			if (routeQuestionState === "decided" || routeQuestionState === "dissolved") setState("decided");
		}
	}, [route.ref, routeQuestionRef, routeQuestionState]);
	const items = merged.filter(
		(item) =>
			(item.state === state ||
				(state === "decided" && item.state === "dissolved" && Boolean(item.decision?.supersedes))) &&
			(!kind || item.kind === kind) &&
			(state !== "open" || !hidden.has(item.q)) &&
			(rules || item.kind !== "map" || !item.decision?.rule),
	);
	for (const question of items) shown.current.set(question.q, question);
	if (cursor === null && items[0]) setCursor(items[0].q);
	const current = cursor === null ? items[0] : (items.find((item) => item.q === cursor) ?? shown.current.get(cursor));
	const answered = current?.decision?.supersedes ?? current?.decision;
	const selection = items.filter((item) => selected.has(item.q));
	const byRef = new Map(items.map((item) => [item.q, item]));
	const alone = (row: Row) => {
		const item = byRef.get(row.q);
		return item ? readOnScreen(item) : false;
	};
	const bulk = state === "open" && selection.length > 0;
	const settledRead = useQueryOp({
		project,
		op: "get",
		input: { refs: [cursor ?? ""] },
		enabled: Boolean(cursor && !items.some((item) => item.q === cursor)),
	});
	const settledState = z.object({ q: z.string(), state: z.string() }).safeParse(settledRead.data?.[0]);
	const unavailable = Boolean(
		current &&
			state === "open" &&
			!items.some((item) => item.q === current.q) &&
			!pendingAnswers.current.has(current.q) &&
			!isUndoing(current.q),
	);
	const settled = Boolean(
		current &&
			state === "open" &&
			!items.some((item) => item.q === current.q) &&
			!pendingAnswers.current.has(current.q) &&
			!isUndoing(current.q) &&
			settledState.success &&
			settledState.data.q === current.q &&
			settledState.data.state !== "open",
	);
	// "Reading this question" is true until the read ends. Once the page knows the question was settled it says
	// that instead, and leaves any other line alone.
	useEffect(() => {
		if (settled)
			setStatus((shown) => (shown === READING ? "This question was settled elsewhere. Your note is kept." : shown));
	}, [settled, setStatus]);
	const counts = inbox.data?.pages[0]?.counts ?? {};
	useEffect(() => {
		// An answer for a selection is asked about while the question shown is outside it; any other is about the
		// question shown, and leaving that question closes it.
		if (
			inline &&
			!inline.entries.some((entry) => entry.question.q === current?.q) &&
			!(inline.kind === "answer" && inline.entries.every((entry) => selected.has(entry.question.q)))
		)
			setInline(null);
	}, [current?.q, inline, selected]);
	const listed = items.map((item) => item.q).join(",");
	useEffect(() => {
		const listedRefs = new Set(listed.split(","));
		const removed = [...selected].filter((ref) => !listedRefs.has(ref));
		if (!removed.length) return;
		setSelected((previous) => new Set([...previous].filter((ref) => listedRefs.has(ref))));
		setInline((previous) => {
			if (previous?.kind !== "answer") return previous;
			const entries = previous.entries.filter((entry) => listedRefs.has(entry.question.q));
			return entries.length ? { ...previous, entries } : null;
		});
		setStatus(`${removed.join(", ")} removed from the selection because it is no longer listed.`);
	}, [listed, selected, setStatus]);
	useEffect(() => {
		if (route.ref) setCursor(route.ref);
	}, [route.ref]);
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
				for (const { question } of entries) {
					counts[question.kind] = Math.max(0, (counts[question.kind] ?? 0) - 1);
					if (question.kind === "adopt" && question.producer === "agent")
						counts["adopt:agent"] = Math.max(0, (counts["adopt:agent"] ?? 0) - 1);
				}
				return { ...previous, counts, items: previous.items.filter((item) => !refs.has(item.q)) };
			},
		);
	}
	function bringBack(questions: QuestionItem[]): void {
		setHidden((previous) => {
			const next = new Set(previous);
			for (const q of questions) next.delete(q.q);
			return next;
		});
		setRestored((previous) => [...questions, ...previous.filter((item) => !questions.some((q) => q.q === item.q))]);
	}
	function extraKey(entry: DecisionEntry, field: InlineAnswer["field"]): string {
		return deviceKey(
			"queue-input",
			`${project}:${entry.question.q}:${String(entry.answer.is)}:${field}`,
			owner.actorId,
		);
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
		setInline({ kind: "answer", entries, field, value: first ? readExtra(first, field) : "" });
		if (current) navigate(routeUrl({ project, screen: "queue", ref: current.q }), { replace: true });
	}
	function rememberInline(next: InlineAnswer): void {
		if (!sessionCurrent(owner)) return;
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
		if (!entries.length || !sessionCurrent(owner)) return;
		if (entries.some((entry) => !items.some((item) => item.q === entry.question.q))) {
			setStatus(settled ? "This question was settled elsewhere. Your note is kept." : READING);
			return;
		}
		for (const entry of entries) {
			const message = questionReadMessage(entry.question);
			if (message) {
				setStatus(message);
				return;
			}
		}
		seenRoute.current = route.ref;
		const action = ++actionNo.current;
		const refs = new Set(entries.map((entry) => entry.question.q));
		for (const ref of refs) {
			pendingAnswers.current.add(ref);
			refActions.current.set(ref, action);
		}
		const index = items.findIndex((item) => item.q === current?.q);
		const next = items.slice(index + 1).find((item) => !refs.has(item.q)) ?? items.find((item) => !refs.has(item.q));
		setHidden((previous) => new Set([...previous, ...refs]));
		setRestored((previous) => previous.filter((question) => !refs.has(question.q)));
		setCursor(next?.q ?? null);
		setSelected(new Set());
		setInline(null);
		void queryClient.cancelQueries({ queryKey: cacheKey });
		patchRemoved(entries);
		const text = `${named(entries.map((entry) => entry.question))} · ${ANSWER_LABELS[String(entries[0]?.answer.is)] ?? entries[0]?.answer.is}`;
		setLastMessage(`${text} · recording`);
		const consequence = entries.some((entry) => entry.question.kind === "adopt")
			? entries[0]?.answer.is === "reject"
				? "The proposal stays in history; the case is unchanged."
				: "The adopted version stays in history."
			: "u withdraws the decision.";
		setStatus(`${text}. ${consequence}`);
		const all = entries.map(({ question, answer }) => ({
			q: question.q,
			onEvidence: question.evidenceHash,
			ifOpen: true,
			answer,
			...(reason ? { reason } : {}),
		}));
		const one = all[0];
		if (!one) return;
		const confirmed = ordered([...refs], () =>
			call("decide", all.length === 1 ? { ...one, cmd: randomId() } : { all, cmd: randomId() }, { project, owner }),
		)
			.then(async (replies) => {
				if (!sessionCurrent(owner)) return [];
				const accepted = entries.flatMap(({ question }) => {
					const reply = replies.find((reply) => reply.q === question.q);
					return reply && (reply.status === "decided" || reply.status === "already") && reply.decision !== null
						? [{ question, decision: reply.decision }]
						: [];
				});
				for (const ref of refs) if (refActions.current.get(ref) === action) pendingAnswers.current.delete(ref);
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
					const conflicts = replies.filter((reply) => reply.status === "conflict" || reply.status === "pending");
					const freshQuestions = conflicts.length
						? z
								.array(QuestionItem)
								.parse(await call("get", { refs: conflicts.map((reply) => reply.q) }, { project, owner }))
						: [];
					if (!sessionCurrent(owner)) return [];
					for (const question of freshQuestions) shown.current.set(question.q, question);
					bringBack(
						rejected.map(
							(entry) => freshQuestions.find((question) => question.q === entry.question.q) ?? entry.question,
						),
					);
					const reply = replies.find((reply) => rejected.some((entry) => entry.question.q === reply.q));
					const message =
						reply?.status === "conflict"
							? reply.needs === "the question is no longer open; read it again before answering"
								? `${reply.q} was settled meanwhile. Read its current decision before answering.`
								: `The evidence changed. ${reply.needs ?? "Read the new evidence before answering."}`
							: reply?.status === "pending"
								? `Approval recorded. ${reply.needs ?? "Waiting for more approvers."}`
								: reply?.status === "advised"
									? `Advice recorded. Needs ${reply.needs ?? rejected[0]?.question.needs}.`
									: `Answer not recorded. Needs ${reply?.needs ?? rejected[0]?.question.needs}.`;
					if (action === actionNo.current) {
						// Show the decision that settled a question meanwhile; it is no longer open, so a key sent to it
						// records nothing. A question whose evidence changed stays where the person left it.
						const settled = replies.find(
							(one) =>
								one.status === "conflict" &&
								one.needs === "the question is no longer open; read it again before answering",
						);
						if (settled) setCursor(settled.q);
						setLastMessage(message);
						setStatus(message);
						setLast(
							accepted.length
								? {
										entries: entries.filter((entry) => accepted.some((one) => one.question.q === entry.question.q)),
										confirmed: Promise.resolve(accepted),
									}
								: null,
						);
					}
					await invalidateProject(project);
					if (!sessionCurrent(owner)) return [];
					const fresh = await call("inbox", { state: "open", limit: 500 }, { project, owner });
					setRestored((previous) => previous.map((item) => fresh.items.find((q) => q.q === item.q) ?? item));
					return accepted;
				}
				if (action === actionNo.current) setLastMessage(`${text} · recorded`);
				await invalidateProject(project);
				setHidden((previous) => {
					const next = new Set(previous);
					for (const ref of refs) if (refActions.current.get(ref) === action) next.delete(ref);
					return next;
				});
				return accepted;
			})
			.catch((error: unknown) => {
				if (!sessionCurrent(owner)) return [];
				for (const ref of refs) if (refActions.current.get(ref) === action) pendingAnswers.current.delete(ref);
				bringBack(entries.map((entry) => entry.question));
				const message = error instanceof Error ? error.message : "The answer could not be recorded. Try again.";
				if (action === actionNo.current) {
					setLastMessage(message);
					setStatus(message);
					setLast(null);
				}
				void invalidateProject(project);
				return [];
			});
		setLast({ entries, confirmed });
	}
	function select(refs: string[]): void {
		// An answer waiting for its reference or reason goes to what it was asked for: the selection holds still.
		if (inline?.kind === "answer") {
			setStatus("Record or cancel the answer before changing the selection.");
			return;
		}
		const { kept, left } = capped(refs);
		setSelected(new Set(kept));
		if (!kept.length) anchor.current = null;
		if (left)
			setStatus(`A selection holds at most ${DECIDE_MAX} questions, the most one answer sends. ${left} left out.`);
	}
	function toggle(question: QuestionItem): void {
		anchor.current = question.q;
		if (selected.has(question.q)) {
			select([...selected].filter((ref) => ref !== question.q));
			return;
		}
		const why = whyNotSelectable(question, selection, alone);
		if (why) setStatus(why);
		else select([...selected, question.q]);
	}
	function selectRange(question: QuestionItem): void {
		const { refs, skipped } = rangeOf(items, selection, anchor.current, question.q, alone);
		anchor.current = question.q;
		select([...new Set([...selected, ...refs])]);
		if (skipped)
			setStatus(
				`${skipped} in the range left out: another kind, questions you cannot settle, or ones answered on their own.`,
			);
	}
	function selectAll(): void {
		const kind = selection[0]?.kind ?? current?.kind;
		if (!kind || state !== "open") return;
		const all = allOfKind(items, kind, alone);
		const { kept, left } = capped(all);
		if (!kept.length) {
			setStatus(
				"No listed question of this kind can be selected: you cannot settle them, or each is answered on its own.",
			);
			return;
		}
		if (kept.every((ref) => selected.has(ref))) {
			select([]);
			return;
		}
		select(all);
		if (inbox.hasNextPage && !left) {
			const keptRefs = new Set(kept);
			setStatus(
				`${counted(items.filter((item) => keptRefs.has(item.q)))} selected. More questions are not listed yet.`,
			);
		}
	}
	useEffect(() => {
		if (!readyAnswer) return;
		setReadyAnswer(null);
		if (current?.q !== readyAnswer.q || state !== "open") {
			setStatus("Queued answer discarded. Read the question again before answering.");
			return;
		}
		answer(readyAnswer.input.is, readyAnswer.input.suggested, readyAnswer.input.via);
	});

	function answer(is: string, suggested?: Record<string, unknown>, via: "key" | "button" = "key"): void {
		if (inline) return;
		const pending = [...undoing.current].find(([prior]) =>
			prior.entries.some((entry) => entry.question.q === current?.q),
		)?.[1];
		if (pending) {
			pending.next = { is, suggested, via };
			setStatus("Answer queued until the withdrawal is confirmed.");
			return;
		}
		if (state !== "open") return;
		if (bulk && suggested) {
			setStatus("Advice is for the question shown. Clear the selection to take it.");
			return;
		}
		if (!bulk && unavailable) {
			setStatus(
				settled
					? "This question was settled elsewhere. Your note is kept; choose another question to answer."
					: READING,
			);
			return;
		}
		const questions = bulk ? selection : current ? [current] : [];
		const first = questions[0];
		if (!first) return;
		if (
			is === "approve" &&
			questions.some((q) => q.kind === "signoff" && q.approvals?.some((a) => a.by === session.actor))
		)
			return;
		if (!bulk && first.you === "forbidden") return;
		for (const question of questions) {
			const message = question.kind === "adopt" ? answerShown(question.q, is, via) : questionReadMessage(question);
			if (message) {
				setStatus(message);
				return;
			}
		}
		if (!bulk && !takes(first, is)) {
			setStatus("This answer does not apply to the current evidence.");
			return;
		}
		if (questions.some((q) => q.kind !== first.kind || q.you === "forbidden" || !takes(q, is))) {
			setStatus(
				questions.some((q) => q.kind !== first.kind)
					? "Select questions of one kind that you may answer."
					: "Not every selected question takes this answer.",
			);
			return;
		}
		if (is === "link" && !suggested) {
			if (questions.length !== 1) {
				setStatus("Link one question at a time so each test can have its own case.");
				return;
			}
			const parsed = MapEvidence.safeParse(first.evidence);
			if (!parsed.success || !parsed.data.tests.length) {
				setStatus("No tests can be linked from this evidence.");
				return;
			}
			const question = first;
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
		const finding = FindingEvidence.safeParse(first.evidence);
		const parsed = ANSWERS[first.kind].safeParse(
			suggested ?? {
				is,
				...(first.kind === "finding" && is === "accept"
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
	function undoShown(question: QuestionItem): void {
		if (!question.decision) return;
		if (last?.command && last.entries.some((entry) => entry.question.q === question.q)) {
			undo(last);
			return;
		}
		undo({
			entries: [{ question, answer: question.decision.answer }],
			confirmed: Promise.resolve([{ question, decision: question.decision.id }]),
		});
	}
	function undo(prior = last, reason?: string, extra?: InlineAnswer): void {
		if (!prior) return;
		const questions = prior.entries.map((entry) => entry.question);
		if (!questions.length || questions.some((question) => isUndoing(question.q))) return;
		if (questions.some((question) => question.state === "dissolved" || question.decision?.supersedes)) {
			setStatus("This answer has ended. There is no answer to withdraw.");
			return;
		}
		if (questions.some((question) => question.kind === "adopt")) {
			setStatus("An adopted edit stays in history. Restore the earlier case version to undo it.");
			setLastMessage(
				"Proposal decisions cannot be withdrawn. To reverse an adopted edit, restore an earlier version in the case pane.",
			);
			return;
		}
		if (!reason && questions.some((q) => q.needs.includes("with a reason"))) {
			const entries = questions.map((question) => ({ question, answer: { is: "withdraw" } }));
			const first = entries[0];
			setCursor(first?.question.q ?? null);
			setInline({
				kind: "withdrawal",
				prior,
				entries,
				field: "reason",
				value: first ? readExtra(first, "reason") : "",
			});
			return;
		}
		setInline(null);
		const pending: { next: QueuedAnswer | null } = { next: null };
		undoing.current.set(prior, pending);
		setCursor(questions[0]?.q ?? null);
		setSelected(new Set());
		setLast(null);
		const reopened = new Set<string>();
		const alreadyOpen = new Set<string>();
		const refused = new Set<string>();
		let receipts: Withdrawal[] = [];
		const action = ++actionNo.current;
		setLastMessage(`${named(questions)} · withdrawing the answer`);
		void ordered(
			questions.map((q) => q.q),
			async () => {
				receipts = await prior.confirmed;
				if (!receipts.length) throw new Error("No confirmed answer is available to withdraw. Read the question again.");
				const failures: string[] = [];
				const withdrawals = receipts.map(({ question, decision }) => ({ q: question.q, ifDecision: decision }));
				const one = withdrawals[0];
				if (!one) return;
				prior.command ??= {
					...(withdrawals.length === 1 ? { undo: one.q, ifDecision: one.ifDecision } : { undo: withdrawals }),
					cmd: randomId(),
					...(reason ? { reason } : {}),
				};
				const replies = await call("decide", prior.command, { project, owner });
				for (const { question } of receipts) {
					try {
						const reply = replies.find((reply) => reply.q === question.q);
						if (!sessionCurrent(owner)) return;
						if (reply?.status === "conflict") {
							const rows = await call("get", { refs: [question.q] }, { project, owner });
							if (!sessionCurrent(owner)) return;
							if (
								rows.some(
									(row) => z.object({ q: z.literal(question.q), state: z.literal("open") }).safeParse(row).success,
								)
							)
								alreadyOpen.add(question.q);
						}
						if (reply?.status !== "reopened" && !alreadyOpen.has(question.q)) {
							if (reply) refused.add(question.q);
							throw new Error(reply?.needs ?? "The decision could not be withdrawn.");
						}
						reopened.add(question.q);
						if (extra) {
							const entry = extra.entries.find((entry) => entry.question.q === question.q);
							if (entry) clearExtra(entry, extra);
						}
					} catch (error) {
						failures.push(`${question.q}: ${error instanceof Error ? error.message : "Try again."}`);
					}
				}
				if (reopened.size) {
					bringBack(
						receipts
							.filter(({ question }) => reopened.has(question.q))
							.map(({ question }) => ({ ...question, state: "open", decision: null })),
					);
					if (action === actionNo.current && cursorRef.current !== null && reopened.has(cursorRef.current)) {
						seenRoute.current = route.ref;
						setState("open");
					}
				}
				if (failures.length) throw new Error(failures.join(" "));
				if (action === actionNo.current) {
					setLast(null);
					const message = alreadyOpen.size
						? `${[...alreadyOpen].join(", ")}: already open.${reopened.size > alreadyOpen.size ? " Other answers withdrawn." : ""}`
						: "Answer withdrawn. Both decisions stay in the ledger.";
					setLastMessage(message);
					setStatus(message);
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
				const q = questions[0]?.q;
				if (pending.next && q && reopened.has(q)) setReadyAnswer({ q, input: pending.next });
			},
		)
			.catch((error: unknown) => {
				if (!sessionCurrent(owner)) return;
				const remaining = receipts.filter(({ question }) => !reopened.has(question.q) && !refused.has(question.q));
				const unconfirmed = new Set(
					questions.filter((question) => !reopened.has(question.q)).map((question) => question.q),
				);
				const detail = error instanceof Error ? error.message : "Try again.";
				const guidance = remaining.length
					? " Press u to retry."
					: /read the question again before withdrawing/i.test(detail)
						? ""
						: " Read the question again before withdrawing.";
				const message = `${[...unconfirmed].join(", ")}: the withdrawal failed. ${reopened.size ? `${reopened.size} confirmed open. ` : ""}${detail}${/[.!?]$/.test(detail) ? "" : "."}${guidance}${pending.next ? " Queued answer discarded." : ""}`;
				if (action === actionNo.current) {
					setLast(
						remaining.length
							? {
									entries: prior.entries.filter((entry) => unconfirmed.has(entry.question.q)),
									confirmed: Promise.resolve(remaining),
									command: prior.command,
								}
							: null,
					);
					setLastMessage(message);
					setStatus(message);
				}
				void invalidateProject(project);
			})
			.finally(() => {
				undoing.current.delete(prior);
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
	const active = () => !inline;
	/** The answers on offer: to the selection when there is one, else to the question shown. */
	const offered = bulk
		? sharedAnswers(selection).filter(
				({ is }) => !(is === "approve" && selection.some((q) => q.approvals?.some((a) => a.by === session.actor))),
			)
		: current
			? Object.entries(ANSWER_KEYS[current.kind])
					.filter(([, is]) => !(is === "approve" && current.approvals?.some((a) => a.by === session.actor)))
					.map(([key, is]) => ({
						key,
						is,
						why:
							current.you === "forbidden"
								? `You cannot settle this. Needs ${current.needs}.`
								: takes(current, is)
									? null
									: "This answer does not apply to the current evidence.",
					}))
			: [];
	const keys: Binding[] = [
		{ key: "j", label: "Next question", handler: () => move(1), applies: active },
		{ key: "k", label: "Previous question", handler: () => move(-1), applies: active },
		{ key: "arrowdown", label: "Next question", handler: () => move(1), applies: active, hidden: true },
		{ key: "arrowup", label: "Previous question", handler: () => move(-1), applies: active, hidden: true },
		{ key: "space", label: "All evidence", handler: () => setFull((value) => !value), applies: active },
		{
			key: "x",
			label: "Select question",
			applies: () => active() && state === "open",
			handler: () => {
				if (current) toggle(current);
			},
		},
		{ key: "*", label: "Select all of this kind", handler: selectAll, applies: () => active() && state === "open" },
		{ key: "escape", label: "Clear selection", handler: () => select([]), applies: () => active() && bulk },
		...offered.map(({ key, is, why }) => ({
			key,
			label: ANSWER_LABELS[is] ?? is,
			handler: () => answer(is),
			applies: () => active() && (state === "open" || Boolean(current && isUndoing(current.q))) && why === null,
		})),
		{
			key: "enter",
			label: "Take advice",
			handler: () => {
				const suggestion = current?.advice.at(-1)?.answer;
				if (suggestion && typeof suggestion.is === "string") answer(suggestion.is, suggestion);
			},
			applies: () => active() && state === "open" && Boolean(current?.advice.length) && current?.you !== "forbidden",
		},
		{
			key: "u",
			label: "Undo answer",
			handler: () => (state === "decided" && current ? undoShown(current) : undo()),
			applies: () =>
				active() &&
				Boolean(last || current?.decision) &&
				current?.state !== "dissolved" &&
				!current?.decision?.supersedes,
		},
	];
	useBindings(keys);
	const answerKind = bulk ? selection[0]?.kind : current?.kind;
	/** What "Select all" in the bar would select: the listed questions of the selection's kind, as many as one answer sends. */
	const selectable = bulk && selection[0] ? capped(allOfKind(items, selection[0].kind, alone)).kept : [];
	const selectableRefs = new Set(selectable);
	const help: Readonly<Record<string, string>> =
		answerKind === "adopt" && current
			? adoptHelpFor(bulk ? selection.map((question) => question.evidence) : [current.evidence])
			: answerKind
				? ANSWER_HELP[answerKind]
				: {};
	return (
		<>
			<section className="pane queue-pane" id="list">
				<div className="phead">
					<b>Queue</b>
					<span className="dim queue-waiting" title={waitingPhrase(counts)}>
						{waitingPhrase(counts)}
					</span>
					<div className="queue-state">
						<button
							type="button"
							aria-pressed={state === "open"}
							onClick={() => {
								setInline(null);
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
								setInline(null);
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
							setInline(null);
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
								setInline(null);
								setKind(value);
								setCursor(null);
								setSelected(new Set());
							}}
						>
							{KIND_WORDS[value].filter} <span>{counts[value] ?? 0}</span>
						</button>
					))}
				</nav>
				{state === "decided" && (
					<label className="queue-rules">
						<input
							type="checkbox"
							checked={rules}
							onChange={(event) => {
								setInline(null);
								setRules(event.target.checked);
							}}
						/>{" "}
						Show unlinked tests decided by rules
					</label>
				)}
				{bulk && selection[0] && (
					<div className="queue-bulk">
						<span>{counted(selection)} selected</span>
						{selectable.some((ref) => !selected.has(ref)) && (
							<button type="button" onClick={selectAll}>
								<KeyCap>*</KeyCap> Select all {counted(items.filter((item) => selectableRefs.has(item.q)))}
							</button>
						)}
						<button type="button" onClick={() => select([])}>
							<KeyCap>Esc</KeyCap> Clear
						</button>
					</div>
				)}
				<div className="pane-scroll" role="listbox" aria-label="Questions" aria-multiselectable="true">
					{items.map((question) => (
						<div data-question={question.q} key={question.q}>
							<ListRow
								selected={current?.q === question.q}
								checked={selected.has(question.q)}
								onClick={(event) => {
									// The box selects, and so does a click with shift (a range) or with ⌘ or Ctrl held.
									const box = event.target instanceof Element && event.target.closest(".queue-check");
									if (state === "open" && (box || event.shiftKey || event.metaKey || event.ctrlKey)) {
										if (event.shiftKey) selectRange(question);
										else toggle(question);
										return;
									}
									setInline(null);
									setCursor(question.q);
									navigate(routeUrl({ project, screen: "queue", ref: question.q }), { replace: true });
								}}
							>
								<span
									className="queue-check"
									data-checked={selected.has(question.q)}
									data-off={state !== "open" || undefined}
									title="Select (x). Shift selects the rows between."
								>
									{selected.has(question.q) ? "✓" : ""}
								</span>
								<ProducerGlyph kind={question.producer} />
								<span className="ref">{question.q}</span>
								<span className={`kind k-${question.kind}`}>{KIND_WORDS[question.kind].tag}</span>
								<span className="queue-title">
									{question.producer === "agent" && <span className="agentv">by an agent · </span>}
									{question.title}
								</span>
								<span className="queue-case ref">{question.about.find((ref) => ref.startsWith("C-"))}</span>
								{question.state === "open" && question.blocks.length > 0 && <span className="blk">blocks gate</span>}
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
						<EmptyState
							{...(!inbox.isPending && state === "open"
								? { doc: { page: "decide", label: "How a question gets here" } }
								: {})}
						>
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
								<span className={`kind k-${current.kind}`}>{KIND_WORDS[current.kind].tag}</span>
								{current.kind === "adopt" && typeof current.evidence.proposal === "string" && (
									<span className="ref">{current.evidence.proposal}</span>
								)}
								<ProducerGlyph kind={current.producer} />
								<span className="dim">{age(current.openedAt)}</span>
								{current.state === "open" && current.blocks.length > 0 && (
									<span className="blk">blocks {current.blocks.join(", ")}</span>
								)}
							</div>
							<h2>{current.title}</h2>
							{state === "open" && (
								<p className="queue-stakes">
									{stakes({
										kind: current.kind,
										tally: ProposalTally.safeParse(current.evidence.tally).data,
										blocks: current.blocks,
										facts: new Set(z.array(z.string()).safeParse(current.evidence.facts).data ?? []),
									})}
								</p>
							)}
							{current.state === "open" && current.kind === "adopt" && whyWaiting(current.asked) && (
								<p className="queue-why">
									{whyWaiting(current.asked)} <DocLink page="policy">How policies work</DocLink>
								</p>
							)}
						</div>
						<div className="pane-scroll queue-evidence" key={current.q}>
							<div className="sech">
								Evidence{" "}
								<button type="button" className="r" onClick={() => setFull((value) => !value)}>
									<KeyCap>space</KeyCap> {full ? "less" : "all of it"}
								</button>
							</div>
							<QuestionEvidence question={current} full={full} />
							{current.kind === "failure" && (
								<>
									<Handoff question={current} active={active} />
									<TrackerCreate key={current.q} question={current} active={active} />
								</>
							)}
							{current.state === "open" && current.seen.carried > 0 && (
								<p className="hintbox">
									An earlier answer carried to {current.seen.carried} occurrences. This evidence is awaiting a fresh
									decision.
								</p>
							)}
							{current.state === "open" && current.approvals?.some((a) => a.by === session.actor) && (
								<p className="hintbox">
									You approved. Waiting for {Math.max(0, (current.approvalNeeded ?? 1) - current.approvals.length)} more
									approval{(current.approvalNeeded ?? 1) - current.approvals.length === 1 ? "" : "s"}.
								</p>
							)}
							{current.approvals?.map((approval) => (
								<div className="hintbox" key={approval.by}>
									{approval.by} approved{approval.reason ? `: ${approval.reason}` : ""}. Policy {approval.policy},
									clause {approval.clause}.
								</div>
							))}
							{current.advice.map((advice) => (
								<div className="hintbox" key={`${advice.by}:${JSON.stringify(advice.answer)}:${advice.reason}`}>
									<ProducerGlyph kind={advice.kind} /> {advice.by} suggests {String(advice.answer.is)}
									{advice.reason && `: ${advice.reason}`} <KeyCap>Enter</KeyCap> takes the suggestion.
								</div>
							))}
							{current.decision && answered && (
								<div className="queue-decision">
									<b>{ANSWER_LABELS[String(answered.answer.is)] ?? String(answered.answer.is)}</b>
									<p className="dim">
										{answered.rule ? `Decided by rule ${answered.rule}` : `Decided by ${answered.by.join(", ")}`} ·{" "}
										{age(answered.at)}
									</p>
									{answered.signers && answered.signers.length > 1
										? answered.signers.map((signer) => (
												<p key={signer.by}>
													{signer.by}
													{signer.reason ? `: ${signer.reason}` : ""}. Policy {signer.policy}, clause {signer.clause}.
												</p>
											))
										: answered.reason && <p>{answered.reason}</p>}
									{current.decision.supersedes && (
										<>
											<p className="dim">
												{endingText(current.decision)} · {age(current.decision.at)}
											</p>
											{current.decision.reason && <p>{current.decision.reason}</p>}
										</>
									)}
									{current.decision.trackerError && (
										<p role="status" className="hintbox">
											{current.decision.trackerError}
										</p>
									)}
									{state === "decided" && current.state === "decided" && !current.decision.supersedes && (
										<button className="out" type="button" onClick={() => undoShown(current)}>
											<KeyCap>u</KeyCap> Withdraw answer
										</button>
									)}
								</div>
							)}
						</div>
						{state === "open" && (
							<div className="queue-answers">
								<div className="queue-needs">
									{isUndoing(current.q) && <p>Withdrawing the answer. An answer key queues a replacement.</p>}
									{settled && <p>This question was settled elsewhere. Your note is kept.</p>}
									{bulk && selection[0]
										? `The answer you choose goes to the ${counted(selection)} selected.${selected.has(current.q) ? "" : " The question shown is not one of them."}`
										: current.you === "forbidden"
											? `You cannot settle this. Needs ${current.needs}.`
											: current.you === "advice"
												? `Your answer is advice. Needs ${current.needs}.`
												: current.kind === "adopt" &&
														current.state === "open" &&
														current.you === "counts" &&
														selected.size <= 1
													? yourAnswerCounts(current.needs)
													: `Needs ${current.needs}.`}
								</div>
								{offered.map(({ key, is, why }) => (
									<button
										className="ans"
										type="button"
										key={key}
										disabled={
											(bulk
												? selection.some((question) => evidenceMessage(question))
												: Boolean(evidenceMessage(current)) || unavailable) ||
											Boolean(inline) ||
											why !== null
										}
										title={why ?? undefined}
										onClick={() => answer(is, undefined, "button")}
									>
										<KeyCap>{key}</KeyCap>
										<b>{ANSWER_LABELS[is]}</b>
										<span>
											{is === "approve" && current.kind === "signoff"
												? bulk
													? "Records an approval for each selected run; closes each run when its required approvals are complete."
													: (current.approvals?.length ?? 0) + 1 >= (current.approvalNeeded ?? 1)
														? "Closes the run with the verdict it has now."
														: `Records ${(current.approvals?.length ?? 0) + 1} of ${current.approvalNeeded} required approvals.`
												: help[is]}
										</span>
									</button>
								))}
							</div>
						)}
					</>
				) : (
					<EmptyState>Select a question to read its evidence and answer keys.</EmptyState>
				)}
				{inline && (
					<AnswerExtra
						kind={inline.kind}
						field={inline.field}
						value={inline.value}
						onChange={(value) => rememberInline({ ...inline, value })}
						onCancel={() => setInline(null)}
						onSubmit={(value) => {
							if (inline.kind === "withdrawal") {
								undo(inline.prior, value, inline);
								return;
							}
							submit(
								inline.entries.map((entry) => ({
									...entry,
									answer: inline.field === "ref" && value ? { ...entry.answer, ref: value } : entry.answer,
								})),
								inline.field === "reason" ? value : undefined,
								inline,
							);
						}}
					/>
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
