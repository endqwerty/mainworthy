// What each kind of decision does. One handler per kind, in one exhaustive map: adding a kind to core/kinds.ts
// without a handler here does not compile.
//
// `effect` is the only place a standing writer is called (it receives the witness). `revert` undoes exactly what
// `effect` recorded, for a withdrawn or expired decision. `holds` says how long the decision carries forward.
import { ANSWERS, type AnswerOf, type AnyAnswer, failureClass, type Kind, type Policy } from "../../core/kinds.ts";
import type { CaseBody } from "../../core/model.ts";
import type { Edit } from "../../core/ops.ts";
import { parseBodyInline } from "../../core/outline.ts";
import {
	dropExcuse,
	dropResultExcuses,
	findTest,
	linkTest,
	mustTarget,
	producedCause,
	restoreLink,
	scopeOf,
	setExcuse,
	setResultExcuses,
	testById,
	unlinkedInFile,
} from "../evidence/evidence.ts";
import { setQuarantine, validateQuarantineEdit } from "../evidence/quarantine.ts";
import { actorById, requirePolicyRoles } from "../identity/identity.ts";
import type { Ctx } from "../kernel/ctx.ts";
import { json } from "../kernel/db.ts";
import { conflict, invalid, notFound } from "../kernel/errors.ts";
import type { Witness } from "../kernel/witness.ts";
import { clauseFor, currentPolicy } from "../policy/policy.ts";
import {
	closeRun,
	discountResults,
	fillsOf,
	findRun,
	gateOf,
	reconsiderEmptyReports,
	reopenRun,
	restoreFailures,
	runById,
	runRef,
} from "../runs/runs.ts";
import {
	adoptSteps,
	bodyOf,
	caseById,
	caseRef,
	cleanBody,
	mustCase,
	proposalById,
	resolvedOf,
	type Sealed,
	sealSteps,
} from "../suite/suite.ts";
import type { Raise, Raised } from "./decisions.ts";
import {
	answersOf,
	type DecisionRow,
	decisionById,
	type HoldTerm,
	type QuestionRow,
	questionById,
	refsOf,
} from "./questions.ts";

type Tools = {
	raiseSteps: (ctx: Ctx, r: Raise) => Generator<undefined, Raised, void>;
	/** Apply the new policy to inherited standing and open questions about tests with no case. */
	reconsiderPolicySteps: (ctx: Ctx) => Generator<undefined, number, void>;
};

type Handler<K extends Kind> = {
	effect: (
		ctx: Ctx,
		witness: Witness,
		question: QuestionRow,
		answer: AnswerOf<K>,
		tools: Tools,
	) => Generator<undefined, Record<string, unknown>, void>;
	revert: (ctx: Ctx, question: QuestionRow, decision: DecisionRow) => void;
	holds: (input: { question: QuestionRow; answer: AnswerOf<K>; now: number; policy: Policy }) => HoldTerm[];
	/** Whether the acting actor wrote the thing in question (the author of a proposal). */
	isAuthor: (ctx: Ctx, question: QuestionRow) => boolean;
	/** Whether the acting actor produced the evidence in question. */
	isProducer: (ctx: Ctx, question: QuestionRow) => boolean;
	undoable: boolean;
	undoHint: string;
};

const untilBasisChanges = (question: QuestionRow): HoldTerm[] => [{ until: "basis-changes", basis: question.basis }];
const DAY = 86_400_000;

/** Raises the `adopt` question for a sealed proposal. Shared by every path that proposes: there is only this one. */
export function raiseAdopt<T>(ctx: Ctx, tools: { raise: (ctx: Ctx, r: Raise) => T }, sealed: Sealed): T {
	const { proposal, resolved } = sealed;
	for (const edit of resolved)
		if (edit.op === "policy") requirePolicyRoles(ctx.db, ctx.project.id, edit.policy.clauses);
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
					...(edit.op === "edit" ? { base: edit.base, conflicts: edit.conflicts.map((c) => c.address) } : {}),
				};
			}
			case "place":
			case "state":
				return { op: edit.op, cases: edit.caseIds.length };
			case "folder":
				return { op: edit.op, name: edit.name };
			case "policy":
				return { op: edit.op, base: edit.base, preset: edit.policy.preset };
			case "quarantine":
				return edit;
			default: {
				const _exhaustive: never = edit;
				return _exhaustive;
			}
		}
	});
	const first = summary[0];
	const quarantine = resolved.find((edit) => edit.op === "quarantine");
	const title = quarantine
		? `${quarantine.exit === null ? "End quarantine" : "Quarantine"} ${quarantine.test}`
		: resolved.length === 1 && first && "title" in first && first.title
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
			authorId: ctx.actor.id,
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
	*effect(ctx, witness, question, answer, tools) {
		const { proposal: id } = json<{ proposal: number }>(question.subject);
		const proposal = proposalById(ctx.db, id);
		if (!proposal) throw notFound("proposal");
		if (answer.is === "reject") return { rejected: true };
		if (answer.is === "merge") return yield* resolveConflictSteps(ctx, proposal, answer, tools);
		for (const edit of resolvedOf(proposal))
			if (edit.op === "policy") requirePolicyRoles(ctx.db, ctx.project.id, edit.policy.clauses);
		const quarantine = resolvedOf(proposal).find((edit) => edit.op === "quarantine");
		if (quarantine) {
			const test = validateQuarantineEdit(ctx, quarantine);
			if (ctx.actor.kind !== "human") throw invalid("a person decides quarantine");
			setQuarantine(ctx, witness, {
				test: test.id,
				exit: quarantine.exit,
				reason: answersOf(ctx.db, question.id).findLast((row) => row.counts === 1)?.reason ?? proposal.reason ?? "",
			});
			return { cases: [], created: [], policyVersion: null, quarantine };
		}
		const adopted = yield* adoptSteps(ctx, witness, proposal);
		const effects = { cases: adopted.cases, created: adopted.created, policyVersion: adopted.policyVersion };
		if (adopted.policyVersion === null) return effects;
		reconsiderEmptyReports(ctx);
		const ruled = yield* tools.reconsiderPolicySteps(ctx);
		return ruled > 0 ? { ...effects, ruled } : effects;
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

/**
 * The author's resolution of a conflict. It adopts nothing: the resolved body becomes a new proposal by the same
 * author, made on the version the conflict was shown against, and meets the adopt policy like any other edit. So
 * resolving a conflict is never a way around a review, and work that landed after the conflict was shown is merged
 * in, or shown as a new conflict, instead of being overwritten. A single case's tag and requirement-link deltas
 * accompany its body, so the entire replacement is judged within its current and proposed tag scope.
 */
function* resolveConflictSteps(
	ctx: Ctx,
	proposal: NonNullable<ReturnType<typeof proposalById>>,
	answer: Extract<AnswerOf<"adopt">, { is: "merge" }>,
	tools: Tools,
): Generator<undefined, Record<string, unknown>, void> {
	const tags = new Set(answer.tags ?? []);
	const covers = new Set(answer.covers ?? []);
	const existingCovers = new Set<string>();
	const edits = resolvedOf(proposal);
	const bodies = edits.filter((edit) => edit.op === "edit");
	const [only] = bodies;
	const unsupported = () =>
		invalid(
			"a merge resolves one case body with only its tag and requirement-link deltas; reject other edits and propose them again on current versions",
		);
	if (bodies.length !== 1 || !only || only.exact) throw unsupported();
	const row = caseById(ctx.db, only.caseId);
	if (!row) throw notFound("case");
	const snapshots = [bodyOf(ctx.db, row.id, only.head), bodyOf(ctx.db, row.id, only.base)];
	const unparsed = [answer.body, cleanBody(answer.body, answer.body)].some((body) => {
		const inline = parseBodyInline(body, snapshots);
		return inline.tags.length > 0 || inline.covers.length > 0;
	});
	if (unparsed)
		throw invalid(
			"extract inline #tags and @requirement links from changed merged fields and send them as tags and covers additions; use the web app to resolve this conflict",
		);
	const ref = caseRef(row);
	const replacement = edits.map((edit): Edit => {
		if (edit.op === "edit") return { op: "edit", case: ref, base: only.head, body: answer.body };
		if (
			edit.op === "place" &&
			edit.caseIds.length === 1 &&
			edit.caseIds[0] === row.id &&
			edit.folder === null &&
			edit.after === undefined &&
			edit.tags &&
			edit.tags.set === null
		)
			return {
				op: "place",
				cases: [ref],
				tags: { add: edit.tags.add, remove: edit.tags.remove.filter((tag) => !tags.has(tag)) },
			};
		if (edit.op === "cover" && edit.caseId === row.id && edit.title === null) {
			existingCovers.add(edit.key);
			return { op: "cover", case: ref, requirement: edit.key, on: edit.on || covers.has(edit.key) };
		}
		throw unsupported();
	});
	if (tags.size) replacement.push({ op: "place", cases: [ref], tags: { add: [...tags] } });
	for (const requirement of covers)
		if (!existingCovers.has(requirement)) replacement.push({ op: "cover", case: ref, requirement, on: true });
	const asAuthor: Ctx = { ...ctx, actor: actorById(ctx.db, proposal.author, ctx.project.id) };
	const sealed = yield* sealSteps(asAuthor, {
		edits: replacement,
		reason: proposal.reason ?? `Resolves the conflict in P-${proposal.no}`,
	});
	if (!sealed) return { cases: [], status: "unchanged" };
	const raised = yield* raiseAdopt(asAuthor, { raise: tools.raiseSteps }, sealed);
	return {
		cases: raised.s === "decided" ? (raised.effects.cases ?? []) : [],
		proposal: `P-${sealed.proposal.no}`,
		adopt: `Q-${raised.question.no}`,
		status: raised.s === "decided" ? "adopted" : sealed.conflicts.length > 0 ? "conflict" : "open",
	};
}

/** Whether a decision is still the one in force on its question. */
function stands(ctx: Ctx, decisionId: number): boolean {
	const decision = decisionById(ctx.db, decisionId);
	const question = decision ? questionById(ctx.db, decision.question) : null;
	return question?.state === "decided" && question.decision === decisionId;
}

/** A link a `map` decision replaced: the test, the case it was linked to, and the decision that had linked it. */
type Relinked = [test: number, previous: number | null, by?: number | null];

const mapHandler: Handler<"map"> = {
	*effect(ctx, witness, question, answer, tools) {
		const { file } = json<{ file: string }>(question.subject);
		switch (answer.is) {
			case "link": {
				const linked: Relinked[] = [];
				for (const [testText, caseText] of answer.pairs) {
					const test = findTest(ctx.db, ctx.project.id, testText);
					if (!test) throw notFound(`test ${testText}`);
					if (test.kind === "manual")
						throw invalid(`${testText} is the manual run of a case and cannot be linked to another`);
					const row = mustCase(ctx.db, ctx.project.id, caseText);
					linked.push([test.id, test.case_id, test.linked_by]);
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
				// Creating and linking in one answer works only where the policy adopts this actor's new cases at
				// once. Where a person must adopt them first, nothing is created here: saying so is better than
				// pointing at a proposal that this answer's refusal would take away again.
				const adoption = clauseFor(currentPolicy(ctx.db, ctx.project.id), {
					kind: "adopt",
					facts: new Set([`author:${ctx.actor.kind}`]),
				});
				if (adoption.ask.who !== "rule") {
					throw invalid(
						"this policy has a person adopt new cases, so they cannot be created and linked in one answer: propose the cases, have them adopted, then answer this question with `link`",
					);
				}
				const acceptance = ANSWERS.adopt.safeParse(adoption.answer);
				if (!acceptance.success || acceptance.data.is !== "accept")
					throw invalid(
						"this policy does not accept new cases automatically: change the adoption rule, or propose the cases, have them adopted, then link",
					);
				const folder = answer.folder ?? folderFor(file);
				const edits: Edit[] = tests.map((test) => ({
					op: "create",
					body: { title: test.name, methods: ["auto"] },
					folder,
				}));
				const sealed = yield* sealSteps(ctx, { edits, reason: `Cases for the tests in ${file}` });
				if (!sealed) return { linked: [] };
				const raised = yield* raiseAdopt(ctx, { raise: tools.raiseSteps }, sealed);
				if (raised.s !== "decided")
					throw invalid("the new cases need a person to adopt them first; accept that proposal, then link");
				const created = raised.effects.created;
				if (!Array.isArray(created) || created.length !== tests.length)
					throw invalid("the adoption rule did not create every requested case; no tests were linked");
				const linked: Relinked[] = [];
				for (const [i, test] of tests.entries()) {
					const ref = created[i];
					if (typeof ref !== "string")
						throw invalid("the adoption rule did not create every requested case; no tests were linked");
					const row = mustCase(ctx.db, ctx.project.id, ref);
					linked.push([test.id, null, null]);
					linkTest(ctx, witness, test, row.id);
					if ((i + 1) % 200 === 0) yield;
				}
				return { linked, created };
			}
			case "track":
				return {};
			case "unlink": {
				const linked: Relinked[] = [];
				for (const id of json<{ tests?: { id: number }[] }>(question.evidence).tests ?? []) {
					const test = testById(ctx.db, id.id);
					if (!test || test.case_id === null || test.kind === "manual") continue;
					linked.push([test.id, test.case_id, test.linked_by]);
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
		// Put back each link this decision made, and only those: a link a newer decision has since made stays. The
		// earlier link returns only while the decision that made it still stands; otherwise the test is unlinked.
		const { linked } = json<{ linked?: Relinked[] }>(decision.effects);
		for (const [testId, previous, by] of linked ?? []) {
			const test = testById(ctx.db, testId);
			if (!test) continue;
			const earlier = by != null && stands(ctx, by) ? { caseId: previous, by } : { caseId: null, by: null };
			restoreLink(ctx, test, decision.id, earlier);
		}
	},
	// "Track" is a judgement about the file as it was: it is asked again when the file's tests with no case
	// change. A link is about the tests it names: it does not carry to a test that turns up later in the file,
	// and that test's question does not undo it.
	holds: ({ question, answer }) => (answer.is === "track" ? untilBasisChanges(question) : [{ until: "results-named" }]),
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

/**
 * The runs a question is about: the runs it lists as waiting for it and every run it names. A decision on a
 * failure changes how each of them counts the failure.
 */
export function runsAbout(ctx: Ctx, question: QuestionRow): number[] {
	const ids = new Set(json<number[]>(question.blocks));
	for (const about of refsOf(ctx.db, question.id)) {
		if (!/^R-\d+$/.test(about)) continue;
		const run = findRun(ctx.db, ctx.project.id, about);
		if (run) ids.add(run.id);
	}
	return [...ids];
}

/** The result producers in this slot, kept on its question after settlement too. */
export function disputeParties(ctx: Ctx, question: QuestionRow): number[] {
	const subject = json<{ slot?: number }>(question.subject);
	return subject.slot === undefined ? [] : [...new Set(fillsOf(ctx.db, subject.slot).map((fill) => fill.actor))];
}

const failureHandler: Handler<"failure"> = {
	*effect(ctx, witness, question, answer) {
		const subject = json<{ signature: number; scope: string; slot?: number }>(question.subject);
		if (subject.slot !== undefined) {
			const { results } = json<{ results: number[] }>(question.evidence);
			if (answer.is === "mistaken") {
				const corrected = discountResults(ctx, witness, results);
				if (corrected.length === 0) throw invalid("this slot no longer counts the failing results");
				return { corrected };
			}
			const klass = failureClass(answer);
			setResultExcuses(ctx, witness, results, klass, { kind: "slot", slot: subject.slot });
			return { class: klass, results, slot: subject.slot };
		}
		if (answer.is === "mistaken") throw invalid("`mistaken` answers a slot dispute, not the whole cause");
		const klass = failureClass(answer);
		if (json<{ perResult?: boolean }>(question.subject).perResult) {
			const { inherited } = json<{ inherited: { result: number; base: number[] }[] }>(question.evidence);
			setResultExcuses(
				ctx,
				witness,
				inherited.map((row) => row.result),
				klass,
			);
			return {
				class: klass,
				results: inherited.map((row) => row.result),
				inherited: answer.is === "inherited" ? inherited : [],
			};
		}
		// A decision that holds on certain targets excuses those and no other.
		const policy = currentPolicy(ctx.db, ctx.project.id);
		const here = failureHandler
			.holds({ question, answer, now: ctx.now, policy })
			.find((term) => term.until === "this-target");
		setExcuse(ctx, witness, {
			signature: subject.signature,
			scope: subject.scope,
			class: klass,
			targets: here?.until === "this-target" ? here.targets : null,
		});
		// The answer covers the build it was given for. Where the question had also seen this cause in another
		// environment of the same commit, that one is not covered: it is asked about again at once, so the commit's
		// gate is never left blocked by a failure nobody is being asked about.
		const covered = here?.until === "this-target" ? here.targets : null;
		const [decidedOn] = covered ?? [];
		const reask =
			decidedOn === undefined
				? []
				: (json<{ targets?: number[] }>(question.evidence).targets ?? []).filter(
						(other) => other !== decidedOn && mustTarget(ctx.db, other).what === mustTarget(ctx.db, decidedOn).what,
					);
		return {
			class: klass,
			signature: subject.signature,
			scope: subject.scope,
			...(answer.is === "defect" && answer.ref ? { defect: answer.ref } : {}),
			...(reask.length > 0 ? { reask } : {}),
		};
	},
	revert(ctx, question, decision) {
		const subject = json<{ signature: number; scope: string }>(question.subject);
		const effects = json<{ corrected?: [number, number][]; class?: string }>(decision.effects);
		if (effects.corrected) restoreFailures(ctx, decision.id);
		if (effects.class) {
			dropExcuse(ctx, subject.signature, subject.scope, decision.id);
			dropResultExcuses(ctx, decision.id);
		}
	},
	holds({ question, answer, now, policy }) {
		const basis = untilBasisChanges(question);
		if (json<{ slot?: number }>(question.subject).slot !== undefined) {
			if (answer.is === "mistaken") return [{ until: "results-named" }];
			return answer.is === "flaky"
				? [...basis, { until: "time", at: now + policy.settings.holds.flakyDays * DAY }]
				: basis;
		}
		if (json<{ perResult?: boolean }>(question.subject).perResult) return basis;
		// The target of the question's latest evidence: the build the person answering was looking at.
		const latest = json<{ targetId?: number }>(question.evidence).targetId;
		const targets = latest !== undefined ? [latest] : [];
		switch (answer.is) {
			case "flaky":
				return [...basis, { until: "time", at: now + policy.settings.holds.flakyDays * DAY }];
			case "infra":
				return policy.settings.holds.infraThisTargetOnly && targets.length > 0
					? [{ until: "this-target", targets }]
					: basis;
			case "inherited":
				// A person's judgement about the build they were looking at: this was already failing where the
				// change started. It covers that build and no other; the next commit is asked about on its own.
				return targets.length > 0 ? [{ until: "this-target", targets }] : basis;
			case "defect":
			case "test":
			case "expected":
				return basis;
			case "mistaken":
				// A judgement on results already recorded. It does not carry to a result reported later, and it is
				// not withdrawn because the cause turns up again.
				return [{ until: "results-named" }];
			default: {
				const _exhaustive: never = answer;
				return _exhaustive;
			}
		}
	},
	isAuthor: () => false,
	/**
	 * A cause answer judges its failure producers in its scope. A slot settlement judges only that slot's parties.
	 */
	isProducer(ctx, question) {
		const subject = json<{ signature: number; scope: string; slot?: number }>(question.subject);
		const actor = ctx.actor.id;
		const kept = json<{ producers?: number[]; parties?: number[] }>(question.evidence);
		if ((kept.producers ?? []).includes(actor) || (kept.parties ?? []).includes(actor)) return true;
		if (subject.slot !== undefined) return disputeParties(ctx, question).includes(actor);
		const reported = producedCause(ctx.db, ctx.project.id, subject.signature, actor).some(
			(seen) => scopeOf(mustTarget(ctx.db, seen.target), seen.run) === subject.scope,
		);
		if (reported) return true;
		return false;
	},
	undoable: true,
	undoHint: "",
};

type Suggestion =
	| { step?: string; action?: string; expected?: string }
	| { case: { title: string; folder?: string; steps: string[] } };

const findingHandler: Handler<"finding"> = {
	*effect(ctx, _witness, question, answer, tools) {
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
		const sealed = yield* sealSteps(asFinder, { edits: [edit], reason: `From finding ${question.title}` });
		if (!sealed) return { applied: false };
		const raised = yield* raiseAdopt(asFinder, { raise: tools.raiseSteps }, sealed);
		// A batch can apply many single-case suggestions, each too small for the case-loop slices.
		yield;
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
	// biome-ignore lint/correctness/useYield: every decision effect is a generator; sign-off has no bulk work.
	*effect(ctx, witness, question, answer) {
		if (answer.is === "reject") return {};
		const run = runById(ctx.db, json<{ run: number }>(question.subject).run);
		if (!run) throw notFound("run");
		// A run is closed on what it shows now, never on what it showed when the sign-off was asked.
		const now = gateOf(ctx, run);
		if (now.verdict !== "passed")
			throw conflict(`${runRef(run)} no longer passes (${now.reason}); it cannot be closed`);
		closeRun(ctx, witness, run);
		return { closed: `R-${run.no}` };
	},
	revert(ctx, question, decision) {
		if (!json<{ closed?: string }>(decision.effects).closed) return;
		const run = runById(ctx.db, json<{ run: number }>(question.subject).run);
		if (run) reopenRun(ctx, run, decision.id);
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
	) => Generator<undefined, Record<string, unknown>, void>;
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
