// What the iOS app reads of the server's replies: every field it decodes, and nothing it does not.
//
// The server's rows have no schema of their own (issue #52), and nobody who changes a reply opens a Swift file.
// So the app's reading is written here, in the language the server is written in:
//
// - `test/ios-contract.test.ts` holds real replies to these shapes. A change that takes away or retypes a field
//   the app reads fails there, on any machine, and names the field. A field that is added fails nothing.
// - `bun scripts/ios.ts gen` writes the Swift types that decode these shapes (`ios/Kit/.../Generated/Wire.swift`).
//   The same test fails when that file is not what this one says.
//
// To change what the app reads: change the shape here, run `bun scripts/ios.ts gen`, and fix what no longer
// compiles in `ios/Kit` (`bun scripts/ios.ts test`, on a Mac). `ios/README.md` says the rest.
import { anything, dictionary, flag, list, maybe, moment, type Shape, struct, text, whole } from "./shape.ts";

// ── Who is signed in ───────────────────────────────────────────────────────────────────────────────────────

const Project = struct("Project", "A project the caller holds a grant on.", {
	key: text,
	name: text,
	policy: [text, "The name of the policy's preset: loose, standard, strict, or custom."],
	can: [list(text), "What the caller may do in this project."],
});

export const SessionInfo = struct("SessionInfo", "`GET /api/session`: who the caller is and what they may open.", {
	actor: [text, "The caller's name."],
	kind: text,
	can: [list(text), "What the caller may do on the instance, not in a project."],
	mode: text,
	via: text,
	session: [maybe(whole), "The id of this session among the caller's own, when signed in with a cookie."],
	owner: flag,
	version: [text, "The server's version."],
	projects: list(Project),
});

// ── The queue ──────────────────────────────────────────────────────────────────────────────────────────────

const Decision = struct("Decision", "The decision that stands on a question.", {
	id: whole,
	answer: [dictionary(anything), "The answer as it was given: `is`, and what that answer carries."],
	by: [list(text), "Who signed it."],
	rule: [maybe(text), "The policy clause that answered, when a rule did."],
	reason: maybe(text),
	at: moment,
});

const Advice = struct("Advice", "An answer that was recorded as advice: somebody else decides.", {
	by: text,
	kind: text,
	answer: dictionary(anything),
	reason: maybe(text),
});

export const Question = struct("Question", "One question of the queue, open or decided.", {
	q: [text, "Its ref, for example Q-12."],
	kind: [text, "adopt, map, failure, finding or signoff. The evidence is read by it."],
	title: text,
	producer: [text, "Who produced the evidence: human, agent, ci or rule."],
	state: text,
	evidence: [anything, "Read by `kind`, as one of the evidence shapes below."],
	evidenceHash: [text, "What an answer says it was given on. Sent back unchanged."],
	seen: struct("Seen", "How often the cause was seen.", { count: whole, carried: whole }),
	needs: [text, "Who the question waits for, as a sentence."],
	answers: [list(text), "The answers that apply to this question, in the order the queue shows them."],
	blocks: [list(text), "The runs it is listed as blocking."],
	about: list(text),
	openedAt: moment,
	advice: list(Advice),
	you: [maybe(text), "What the caller's answer would be worth: counts, advice or forbidden. In a listing only."],
	decision: maybe(Decision),
});

export const Inbox = struct("Inbox", "`inbox`: a page of questions, and how many are open of each kind.", {
	counts: [dictionary(whole), "Open questions by kind, and `open` for all of them. A kind with none is absent."],
	items: list(Question),
	cursor: maybe(text),
});

const TestRef = struct("TestRef", "A test a question is about.", {
	t: [text, "Its ref, for example T-9."],
	name: text,
	case: [maybe(text), "The case it is linked to, where it is."],
});

/** What the policy is asked about a question: `conflict`, `policy`, `scope:change`. The stakes are read from it. */
const FACTS = list(text);

/** A question's evidence, by the question's kind. A kind the app does not know is shown and cannot be answered. */
export const EVIDENCE = {
	failure: struct("FailureEvidence", "A failed result nobody has explained.", {
		message: [maybe(text), "The failure as the runner reported it."],
		scope: [text, "Where it was asked: a change (pr:482), the trunk, or a run."],
		tests: [list(TestRef), "The tests that share the cause: the first fifty."],
		count: [whole, "How many tests share the cause."],
		target: [text, "The commit, shortened, or what else was tested."],
		branch: maybe(text),
		hints: [list(text), "What the server noticed: fails-on-base, disputed."],
		facts: FACTS,
	}),
	map: struct("MapEvidence", "Tests of one file that have no case.", {
		file: text,
		tests: list(TestRef),
		count: whole,
		facts: FACTS,
	}),
	finding: struct("FindingEvidence", "What a review found.", {
		on: [text, "Where: a case (C-311), a step (C-311#b7), a requirement or a change."],
		case: maybe(text),
		caseTitle: maybe(text),
		step: maybe(text),
		category: text,
		note: text,
		repro: maybe(text),
		suggest: [maybe(anything), "An edit the finder suggests. Accepting can turn it into a proposal."],
		finder: text,
		lens: text,
		facts: FACTS,
	}),
	adopt: struct("AdoptEvidence", "A proposed edit that waits for a person.", {
		proposal: text,
		author: text,
		reason: maybe(text),
		edits: [list(dictionary(anything)), "A summary of each edit, the first twenty: `op`, and what it changes."],
		count: whole,
		conflicts: list(
			struct("EditConflict", "A case the edit cannot be merged into.", { case: text, paths: list(text) }),
		),
		facts: FACTS,
	}),
	signoff: struct("SignoffEvidence", "A run that can be closed.", {
		run: text,
		name: text,
		verdict: text,
		tally: dictionary(whole),
		facts: FACTS,
	}),
} as const satisfies Record<string, Shape>;

export const DecideReply = struct("DecideReply", "`decide`: what became of one answer, or of one withdrawal.", {
	q: text,
	status: [text, "decided, advised, already, conflict, forbidden, invalid or reopened."],
	needs: [maybe(text), "Why not, or who decides instead, as a sentence."],
	decision: maybe(whole),
	evidence: [maybe(text), "On a conflict: the evidence the question has now."],
});

// ── A case's content, and an edit somebody proposes ────────────────────────────────────────────────────────

const Step = struct("Step", "One step of a case.", {
	id: [text, "Short, unique within its case and never used again, so a result or an edit can name the step."],
	action: text,
	expected: [maybe(text), "What must be true afterwards, where the author said."],
});

export const CaseBody = struct("CaseBody", "The content of a case that has versions.", {
	title: text,
	pre: [text, "Preconditions. Empty when there are none."],
	steps: list(Step),
});

export const Proposal = struct("Proposal", "`get` with a P- ref: a proposed edit with the documents it would change.", {
	ref: text,
	edits: list(
		struct("ProposalEdit", "One edit of a proposal. Which fields it carries depends on `op`.", {
			op: [text, "create, edit, restore, place, state, folder, cover or policy."],
			case: maybe(text),
			body: [maybe(CaseBody), "For create, edit and restore: the case as it would be."],
			current: [maybe(CaseBody), "For edit: the case as it is now."],
		}),
	),
});

// ── The change stream ──────────────────────────────────────────────────────────────────────────────────────

export const ChangeEvent = struct("ChangeEvent", "One event of `GET /api/p/<project>/events`: something changed.", {
	project: text,
	seq: whole,
	op: text,
	touched: [list(text), "The refs the command touched. Empty does not mean nothing changed."],
});

/** Every shape the app decodes by name. `gen` writes one Swift type for each, and for each struct inside it. */
export const SHAPES: readonly Shape[] = [
	SessionInfo,
	Inbox,
	...Object.values(EVIDENCE),
	DecideReply,
	Proposal,
	ChangeEvent,
];
