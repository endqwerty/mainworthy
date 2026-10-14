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
import { anything, dictionary, flag, list, maybe, moment, nullable, type Shape, struct, text, whole } from "./shape.ts";

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

const GivenAnswer = struct("GivenAnswer", "An answer as it was given. It carries more, by what it is.", {
	is: [text, "The answer's word: flaky, accept. Or withdrawn, expired, outdated for a row the ledger wrote."],
	ref: [maybe(text), "For a defect: where it is tracked."],
});

const Decision = struct("Decision", "The decision that stands on a question.", {
	id: whole,
	answer: GivenAnswer,
	by: [list(text), "Who signed it."],
	rule: [maybe(text), "The policy clause that answered, when a rule did."],
	reason: maybe(text),
	at: moment,
});

const Advice = struct("Advice", "An answer that was recorded as advice: somebody else decides.", {
	by: text,
	kind: text,
	answer: GivenAnswer,
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
		suggest: [
			maybe(
				struct("Suggestion", "An edit a finder suggests: to one step, or a new case.", {
					step: [maybe(text), "The step the edit is made to. Where absent, the step the finding is on."],
					action: maybe(text),
					expected: maybe(text),
					case: maybe(
						struct("SuggestedCase", "A case a finder suggests adding.", {
							title: text,
							folder: [maybe(text), "The folder the case would go into."],
							steps: list(text),
						}),
					),
				}),
			),
			"Accepting the finding turns it into a proposal by the finder.",
		],
		finder: text,
		lens: text,
		facts: FACTS,
	}),
	adopt: struct("AdoptEvidence", "A proposed edit that waits for a person.", {
		proposal: text,
		author: text,
		reason: maybe(text),
		edits: [
			list(
				struct("EditSummary", "One edit of a proposal in short. Which fields it carries depends on `op`.", {
					op: [text, "create, edit, restore, place, state, folder, cover or policy."],
					case: maybe(text),
					title: maybe(text),
					cases: [maybe(whole), "For place and state: how many cases."],
					name: [maybe(text), "For folder: its name."],
					preset: [maybe(text), "For policy: the preset it changes to."],
				}),
			),
			"The first twenty edits.",
		],
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
	expected: [nullable(text), "What must be true afterwards. Null where the author has not said; never left out."],
});

const CaseBodyFields = {
	title: text,
	pre: [text, "Preconditions. Empty when there are none."],
	steps: list(Step),
	methods: [list(text), "Who may produce evidence for the case: human, auto, agent."],
	automate: [text, "Whether an automated test is wanted: none, wanted or not-applicable."],
	fields: [dictionary(text), "Custom field values. All of a case's content is here, so an edit is shown whole."],
} as const;
export const CaseBody = struct("CaseBody", "The content of a case that has versions.", CaseBodyFields);

export const Proposal = struct("Proposal", "`get` with a P- ref: a proposed edit with the documents it would change.", {
	ref: text,
	edits: list(
		struct("ProposalEdit", "One edit of a proposal. Which fields it carries depends on `op`.", {
			op: [text, "create, edit, restore, place, state, folder, cover or policy."],
			case: maybe(text),
			body: [maybe(CaseBody), "For create, edit and restore: the case as it would be."],
			current: [maybe(CaseBody), "For edit: the case as it is now."],
			folder: [maybe(text), "For create: the path of the folder the case goes into."],
			tags: [maybe(anything), "For create: the case's tags, a list of words. Another edit writes it otherwise."],
			covers: [maybe(list(text)), "For create: the requirements the case covers."],
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

// Planned runs, their pinned slots, and manual results.
export const PlannedRun = struct("PlannedRun", "A planned run, with the server's verdict.", {
	ref: text,
	name: text,
	state: text,
	verdict: text,
	reason: text,
	slots: maybe(whole),
	tally: dictionary(whole),
	accepts: struct("RunTarget", "Only this run, or a commit's results.", {
		self: maybe(flag),
		commit: maybe(text),
		repo: maybe(text),
		env: maybe(text),
	}),
});
export const RunPage = struct("RunPage", "A page of planned runs, newest first.", {
	items: list(PlannedRun),
	cursor: maybe(text),
});
const RunFill = struct("RunFill", "An admitted result that fills a slot.", {
	result: whole,
	by: text,
	method: text,
	outcome: text,
	note: maybe(text),
	atStep: maybe(text),
});
export const RunSlot = struct("RunSlot", "One case pinned at a version in a run, in order.", {
	id: whole,
	case: maybe(text),
	title: maybe(text),
	version: whole,
	state: text,
	fills: list(RunFill),
});
export const SlotPage = struct("SlotPage", "A page of slots in their planned order.", {
	items: list(RunSlot),
	cursor: maybe(text),
});
export const PinnedCase = struct("PinnedCase", "The content at the slot's pinned version.", {
	ref: text,
	version: whole,
	...CaseBodyFields,
	fields: [maybe(dictionary(text)), "Custom field values. A case that is read alone leaves them out."],
});
export const RunFolders = struct("RunFolders", "The folders a run can select.", {
	items: list(struct("RunFolder", "A folder path.", { path: text })),
});
export const RunPlanReply = struct("RunPlanReply", "The run made by a plan.", {
	run: text,
	slots: whole,
	already: whole,
});
const ReportRefusal = struct("ReportRefusal", "Why one result was not recorded.", { reason: text });
export const RunReportReply = struct("RunReportReply", "What became of a small manual report.", {
	rejected: list(ReportRefusal),
	declined: list(ReportRefusal),
	results: list(whole),
});

// ── Changes and the person's sessions ──────────────────────────────────────────────────────────────────────

export const ChangeList = struct("ChangeList", "`find` in changes: newest first, with the head's gate.", {
	items: list(
		struct("ChangeSummary", "A reported branch or pull request.", {
			key: text,
			title: maybe(text),
			branch: maybe(text),
			head: maybe(text),
			url: maybe(text),
			state: text,
			verdict: maybe(text),
		}),
	),
});

export const ChangeGate = struct("ChangeGate", "`gate` of a change's head commit.", {
	run: maybe(text),
	verdict: text,
	reason: text,
	tally: dictionary(whole),
	stale: flag,
});

export const ChangeImpact = struct("ChangeImpact", "`impact` of a change: its base and the cases it touches.", {
	change: struct("ChangeBasis", "The change and commits the affected cases were read for.", {
		key: text,
		head: maybe(text),
		base: maybe(text),
		title: maybe(text),
		state: [text, "Open, merged or closed, as it is now: a change older than the list's newest is read here."],
	}),
	gate: maybe(struct("ChangeImpactGate", "The run counted for this head, if any.", { run: maybe(text) })),
	counts: struct("ChangeImpactCounts", "The complete number of affected cases.", { cases: whole }),
	cases: list(
		struct("ChangedCase", "An affected case and why it is in the set.", {
			id: text,
			title: text,
			why: list(text),
			last: maybe(text),
		}),
	),
});

export const ChangeRun = struct("ChangeRun", "`get` of the head's run: the first fifty failing tests.", {
	ref: text,
	accepts: struct("ChangeRunTarget", "The commit this run actually counts, not the change's current head.", {
		commit: text,
	}),
	change: maybe(
		struct("ChangeRunHeader", "The change as it is now, which may have moved beyond this run.", {
			key: text,
			head: maybe(text),
			branch: maybe(text),
			url: maybe(text),
		}),
	),
	failing: maybe(
		list(
			struct("ChangeFailure", "A failed test with its linked case, if any.", {
				test: maybe(text),
				name: maybe(text),
				file: maybe(text),
				case: maybe(text),
				cause: maybe(text),
			}),
		),
	),
});

export const SessionRow = struct("SessionRow", "`session` list: one of the caller's living sessions.", {
	id: whole,
	openedWith: text,
	label: text,
	userAgent: maybe(text),
	createdAt: moment,
	createdFrom: maybe(text),
	lastUsedAt: moment,
	lastUsedFrom: maybe(text),
	expiresAt: moment,
	current: flag,
});

export const SessionEnd = struct("SessionEnd", "`session` end: whether it ended, and whether it was this device's.", {
	ended: flag,
	current: flag,
});

/** Every shape the app decodes by name. `gen` writes one Swift type for each, and for each struct inside it. */
export const SHAPES: readonly Shape[] = [
	SessionInfo,
	Inbox,
	...Object.values(EVIDENCE),
	DecideReply,
	Proposal,
	ChangeEvent,
	PlannedRun,
	RunPage,
	RunSlot,
	SlotPage,
	PinnedCase,
	RunFolders,
	RunPlanReply,
	RunReportReply,
	ChangeList,
	ChangeGate,
	ChangeImpact,
	ChangeRun,
	SessionRow,
	SessionEnd,
];
