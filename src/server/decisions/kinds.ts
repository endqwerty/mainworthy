// What each kind of decision does. One handler per kind, in one exhaustive map: adding a kind to core/kinds.ts
// without a handler here does not compile.
//
// `effect` is the only place a standing writer is called (it receives the witness). `revert` undoes exactly what
// `effect` recorded, for a withdrawn or expired decision. `holds` says how long the decision carries forward.
import { type AnswerOf, type AnyAnswer, failureClass, type Kind, type Policy } from "../../core/kinds.ts";
import type { CaseBody } from "../../core/model.ts";
import type { Edit } from "../../core/ops.ts";
import { dropExcuse, findTest, linkTest, setExcuse, testById, unlinkedInFile } from "../evidence/evidence.ts";
import { actorById } from "../identity/identity.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { json } from "../kernel/db.ts";
import { invalid, notFound } from "../kernel/errors.ts";
import type { Witness } from "../kernel/witness.ts";
import { closeRun, discountFailures, reopenRun, restoreFailures, runById } from "../runs/runs.ts";
import { adopt, bodyOf, caseById, findCase, mustCase, proposalById, resolvedOf, seal } from "../suite/suite.ts";
import type { Raise, Raised } from "./decisions.ts";
import type { DecisionRow, HoldTerm, QuestionRow } from "./questions.ts";

type Tools = { raise: (ctx: Ctx, r: Raise) => Raised };

type Handler<K extends Kind> = {
	effect: (
		ctx: Ctx,
		witness: Witness,
		question: QuestionRow,
		answer: AnswerOf<K>,
		tools: Tools,
	) => Record<string, unknown>;
	revert: (ctx: Ctx, question: QuestionRow, decision: DecisionRow) => void;
	holds: (input: { question: QuestionRow; answer: AnswerOf<K>; now: number; policy: Policy }) => HoldTerm[];
	/** Whether the acting actor wrote the thing in question (the author of a proposal). */
	isAuthor: (ctx: Ctx, question: QuestionRow) => boolean;
	/** Whether the acting actor produced the evidence in question. */
	isProducer: (ctx: Ctx, question: QuestionRow) => boolean;
	undoable: boolean;
	undoHint: string;
};

const untilBasisChanges = (question: QuestionRow): HoldTerm[] => [
	{ until: "basis-changes", basis: question.evidence_hash },
];
const DAY = 86_400_000;

/** Raises the `adopt` question for a sealed proposal. Shared by every path that proposes: there is only this one. */
export function raiseAdopt(ctx: Ctx, tools: Tools, sealed: NonNullable<ReturnType<typeof seal>>): Raised {
	const { proposal, resolved } = sealed;
	const summary = resolved.slice(0, 20).map((edit) => {
		switch (edit.op) {
			case "create":
				return { op: edit.op, title: edit.body.title, steps: edit.body.steps.length };
			case "edit":
			case "restore":
			case "cover": {
				const row = caseById(ctx.db, edit.caseId);
				return {
					op: edit.op,
					case: row ? `C-${row.no}` : null,
					title: row?.title ?? null,
					...(edit.op === "edit" ? { base: edit.base, conflicts: edit.conflicts.map((c) => c.path) } : {}),
				};
			}
			case "place":
			case "state":
				return { op: edit.op, cases: edit.caseIds.length };
			case "folder":
				return { op: edit.op, name: edit.name };
			case "policy":
				return { op: edit.op, preset: edit.policy.preset };
			default: {
				const _exhaustive: never = edit;
				return _exhaustive;
			}
		}
	});
	const first = summary[0];
	const title =
		resolved.length === 1 && first && "title" in first && first.title
			? `${first.op === "create" ? "New case" : first.op === "edit" ? "Edit" : first.op}: ${first.title}`
			: `${resolved.length} edits`;
	return tools.raise(ctx, {
		kind: "adopt",
		key: `proposal:${proposal.id}`,
		subject: { proposal: proposal.id },
		title,
		producer: ctx.actor.kind,
		evidence: {
			proposal: `P-${proposal.no}`,
			author: ctx.actor.name,
			reason: proposal.reason,
			edits: summary,
			count: resolved.length,
			conflicts: sealed.conflicts,
		},
		material: { proposal: proposal.id },
		facts: sealed.facts,
		refs: [`P-${proposal.no}`, ...sealed.cases],
		runs: [],
	});
}

const adoptHandler: Handler<"adopt"> = {
	effect(ctx, witness, question, answer) {
		const { proposal: id } = json<{ proposal: number }>(question.subject);
		const proposal = proposalById(ctx.db, id);
		if (!proposal) throw notFound("proposal");
		if (answer.is === "reject") return { rejected: true };
		if (answer.is === "merge" && resolvedOf(proposal).filter((edit) => edit.op === "edit").length !== 1) {
			throw invalid(
				"a merge resolves one edited case; this proposal changes several, so reject it and propose each again",
			);
		}
		const adopted = adopt(ctx, witness, proposal, answer.is === "merge" ? answer.body : undefined);
		return { cases: adopted.cases, created: adopted.created, policyVersion: adopted.policyVersion };
	},
	revert() {
		throw invalid("an adopted edit is undone by restoring the earlier version, which keeps both in the history");
	},
	holds: ({ question }) => untilBasisChanges(question),
	isAuthor(ctx, question) {
		const { proposal } = json<{ proposal: number }>(question.subject);
		return proposalById(ctx.db, proposal)?.author === ctx.actor.id;
	},
	isProducer(ctx, question) {
		return adoptHandler.isAuthor(ctx, question);
	},
	undoable: false,
	undoHint: "restore the earlier version of the case instead; both versions stay in its history",
};

const mapHandler: Handler<"map"> = {
	effect(ctx, witness, question, answer, tools) {
		const { file } = json<{ file: string }>(question.subject);
		switch (answer.is) {
			case "link": {
				const linked: [number, number | null][] = [];
				for (const [testText, caseText] of answer.pairs) {
					const test = findTest(ctx.db, ctx.project.id, testText);
					if (!test) throw notFound(`test ${testText}`);
					const row = mustCase(ctx.db, ctx.project.id, caseText);
					linked.push([test.id, test.case_id]);
					linkTest(ctx, witness, test, row.id);
					ctx.touched.add(`C-${row.no}`);
				}
				return { linked };
			}
			case "create": {
				// New cases go through the same adopt path as any edit. If policy does not adopt them now, the
				// tests stay unlinked and this question is asked again when the proposal lands.
				const tests = unlinkedInFile(ctx.db, ctx.project.id, file);
				if (tests.length === 0) return { linked: [] };
				const folder = answer.folder ?? folderFor(file);
				const edits: Edit[] = tests.map((test) => ({
					op: "create",
					body: { title: test.name, methods: ["auto"] },
					folder,
				}));
				const sealed = seal(ctx, { edits, reason: `Cases for the tests in ${file}` });
				if (!sealed) return { linked: [] };
				const raised = raiseAdopt(ctx, tools, sealed);
				if (raised.s !== "decided")
					throw invalid("the new cases need a person to adopt them first; accept that proposal, then link");
				const created = (raised.effects.created ?? []) as string[];
				const linked: [number, number | null][] = [];
				tests.forEach((test, i) => {
					const row = created[i] ? findCase(ctx.db, ctx.project.id, created[i]) : null;
					if (!row) return;
					linked.push([test.id, null]);
					linkTest(ctx, witness, test, row.id);
				});
				return { linked, created };
			}
			case "track":
				return {};
			case "unlink": {
				const linked: [number, number | null][] = [];
				for (const id of json<{ tests?: { id: number }[] }>(question.evidence).tests ?? []) {
					const test = testById(ctx.db, id.id);
					if (!test || test.case_id === null) continue;
					linked.push([test.id, test.case_id]);
					linkTest(ctx, witness, test, null);
				}
				return { linked };
			}
			default: {
				const _exhaustive: never = answer;
				return _exhaustive;
			}
		}
	},
	revert(ctx, _question, decision) {
		// Put each test back where it was. The witness of the decision being withdrawn authorises the reversal.
		const { linked } = json<{ linked?: [number, number | null][] }>(decision.effects);
		for (const [testId, previous] of linked ?? []) {
			const test = testById(ctx.db, testId);
			if (test) ctx.db.raw.query("UPDATE tests SET case_id = ? WHERE id = ?").run(previous, test.id);
		}
	},
	holds: ({ question }) => untilBasisChanges(question),
	isAuthor: () => false,
	isProducer: () => false,
	undoable: true,
	undoHint: "",
};

/** `tests/checkout/coupon.spec.ts` suggests the folder `checkout`; a file with no directory goes to `Automated`. */
function folderFor(file: string): string {
	const parts = file.split("/").filter((part) => part && !/^(src|tests?|specs?|e2e|__tests__|lib|app)$/i.test(part));
	parts.pop();
	return parts.length > 0 ? parts.slice(0, 3).join("/") : "Automated";
}

const failureHandler: Handler<"failure"> = {
	effect(ctx, witness, question, answer) {
		const subject = json<{ signature: number; scope: string }>(question.subject);
		if (answer.is === "mistaken") {
			const corrected: [number, number][] = [];
			for (const runId of json<number[]>(question.blocks)) {
				const run = runById(ctx.db, runId);
				if (run?.origin === "planned") corrected.push(...discountFailures(ctx, witness, run, subject.signature));
			}
			if (corrected.length === 0)
				throw invalid("`mistaken` is for a disputed result in a planned run; this failure has none");
			return { corrected };
		}
		const klass = failureClass(answer);
		setExcuse(ctx, witness, { signature: subject.signature, scope: subject.scope, class: klass });
		return {
			class: klass,
			signature: subject.signature,
			scope: subject.scope,
			...(answer.is === "defect" && answer.ref ? { defect: answer.ref } : {}),
		};
	},
	revert(ctx, question, decision) {
		const subject = json<{ signature: number; scope: string }>(question.subject);
		const effects = json<{ corrected?: [number, number][]; class?: string }>(decision.effects);
		if (effects.corrected) restoreFailures(ctx, effects.corrected);
		if (effects.class) dropExcuse(ctx, subject.signature, subject.scope);
	},
	holds({ question, answer, now, policy }) {
		const basis = untilBasisChanges(question);
		const target = json<{ targetId?: number }>(question.evidence).targetId;
		switch (answer.is) {
			case "flaky":
				return [...basis, { until: "time", at: now + policy.settings.holds.flakyDays * DAY }];
			case "infra":
				return policy.settings.holds.infraThisTargetOnly && target !== undefined
					? [{ until: "this-target", target }]
					: basis;
			case "inherited":
				return [...basis, { until: "fact-gone", fact: "hint:fails-on-base" }];
			case "defect":
			case "test":
			case "expected":
			case "mistaken":
				return basis;
			default: {
				const _exhaustive: never = answer;
				return _exhaustive;
			}
		}
	},
	isAuthor: () => false,
	isProducer(ctx, question) {
		return (json<{ producers?: number[] }>(question.evidence).producers ?? []).includes(ctx.actor.id);
	},
	undoable: true,
	undoHint: "",
};

type Suggestion =
	| { step?: string; action?: string; expected?: string }
	| { case: { title: string; folder?: string; steps: string[] } };

const findingHandler: Handler<"finding"> = {
	effect(ctx, _witness, question, answer, tools) {
		if (answer.is !== "accept" || !answer.apply) return {};
		const evidence = json<{ suggest?: Suggestion; finderId?: number; case?: string; step?: string }>(question.evidence);
		if (!evidence.suggest)
			throw invalid("this finding has no suggestion to apply; accept it without `apply` and make the change yourself");
		let edit: Edit;
		if ("case" in evidence.suggest) {
			const { title, folder, steps } = evidence.suggest.case;
			edit = {
				op: "create",
				outline: [title, ...steps.map((step) => `  - ${step}`)].join("\n"),
				...(folder ? { folder } : {}),
			};
		} else {
			if (!evidence.case) throw invalid("the finding does not name a case to change");
			const row = mustCase(ctx.db, ctx.project.id, evidence.case);
			const body: CaseBody = bodyOf(ctx.db, row.id, row.head);
			const stepId = evidence.suggest.step ?? evidence.step;
			const suggestion = evidence.suggest;
			const steps = body.steps.map((step) =>
				step.id === stepId
					? { ...step, action: suggestion.action ?? step.action, expected: suggestion.expected ?? step.expected }
					: step,
			);
			if (!body.steps.some((step) => step.id === stepId))
				throw invalid(`${evidence.case} has no step ${stepId ?? "(none named)"}`);
			edit = { op: "edit", case: evidence.case, base: row.head, body: { steps } };
		}
		// The suggestion becomes a proposal authored by the finder, and meets the same adopt policy as any edit.
		const finder = evidence.finderId !== undefined ? actorById(ctx.db, evidence.finderId, ctx.project.id) : ctx.actor;
		const asFinder: Ctx = { ...ctx, actor: finder };
		const sealed = seal(asFinder, { edits: [edit], reason: `From finding ${question.title}` });
		if (!sealed) return { applied: false };
		const raised = raiseAdopt(asFinder, tools, sealed);
		return {
			proposal: `P-${sealed.proposal.no}`,
			adopt: `Q-${raised.question.no}`,
			status: raised.s === "decided" ? "adopted" : "open",
		};
	},
	revert() {},
	holds: ({ question }) => untilBasisChanges(question),
	isAuthor: () => false,
	isProducer(ctx, question) {
		return json<{ finderId?: number }>(question.evidence).finderId === ctx.actor.id;
	},
	undoable: true,
	undoHint: "",
};

const signoffHandler: Handler<"signoff"> = {
	effect(ctx, witness, question, answer) {
		if (answer.is === "reject") return {};
		const run = runById(ctx.db, json<{ run: number }>(question.subject).run);
		if (!run) throw notFound("run");
		closeRun(ctx, witness, run);
		return { closed: `R-${run.no}` };
	},
	revert(ctx, question, decision) {
		if (!json<{ closed?: string }>(decision.effects).closed) return;
		const run = runById(ctx.db, json<{ run: number }>(question.subject).run);
		if (run) reopenRun(ctx, run);
	},
	holds: ({ question }) => untilBasisChanges(question),
	isAuthor: () => false,
	isProducer: () => false,
	undoable: true,
	undoHint: "",
};

type AnyHandler = {
	effect: (
		ctx: Ctx,
		witness: Witness,
		question: QuestionRow,
		answer: AnyAnswer,
		tools: Tools,
	) => Record<string, unknown>;
	revert: Handler<Kind>["revert"];
	holds: (input: { question: QuestionRow; answer: AnyAnswer; now: number; policy: Policy }) => HoldTerm[];
	isAuthor: Handler<Kind>["isAuthor"];
	isProducer: Handler<Kind>["isProducer"];
	undoable: boolean;
	undoHint: string;
};

const TYPED: { [K in Kind]: Handler<K> } = {
	adopt: adoptHandler,
	map: mapHandler,
	failure: failureHandler,
	finding: findingHandler,
	signoff: signoffHandler,
};

/**
 * The handlers by kind. `settle` validates the answer against the kind's schema before it calls a handler, which is
 * what makes handing each handler its own answer type sound; this map only erases that pairing for the lookup.
 */
export const HANDLERS: Record<Kind, AnyHandler> = TYPED as unknown as Record<Kind, AnyHandler>;
