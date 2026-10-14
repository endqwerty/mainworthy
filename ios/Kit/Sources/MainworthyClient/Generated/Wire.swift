// Written by `bun scripts/ios.ts gen` from scripts/ios/contract.ts. Do not edit it: change that file and run the command again.

/// The server's replies, as far as the app reads them. A field the server sends and the app does not read is
/// not here. Nothing outside this module sees these types: each is turned into one of the app's own where
/// it is decoded.
enum Wire {
	/// A project the caller holds a grant on.
	struct Project: Decodable, Equatable, Sendable {
		let key: String
		let name: String
		/// The name of the policy's preset: loose, standard, strict, or custom.
		let policy: String
		/// What the caller may do in this project.
		let can: [String]
	}

	/// `GET /api/session`: who the caller is and what they may open.
	struct SessionInfo: Decodable, Equatable, Sendable {
		/// The caller's name.
		let actor: String
		let kind: String
		/// What the caller may do on the instance, not in a project.
		let can: [String]
		let mode: String
		let via: String
		/// The id of this session among the caller's own, when signed in with a cookie.
		let session: Int?
		let owner: Bool
		/// The server's version.
		let version: String
		let projects: [Project]
	}

	/// How often the cause was seen.
	struct Seen: Decodable, Equatable, Sendable {
		let count: Int
		let carried: Int
	}

	/// An answer as it was given. It carries more, by what it is.
	struct GivenAnswer: Decodable, Equatable, Sendable {
		/// The answer's word: flaky, accept. Or withdrawn, expired, outdated for a row the ledger wrote.
		let `is`: String
		/// For a defect: where it is tracked.
		let ref: String?
	}

	/// An answer that was recorded as advice: somebody else decides.
	struct Advice: Decodable, Equatable, Sendable {
		let by: String
		let kind: String
		let answer: GivenAnswer
		let reason: String?
	}

	/// The decision that stands on a question.
	struct Decision: Decodable, Equatable, Sendable {
		let id: Int
		let answer: GivenAnswer
		/// Who signed it.
		let by: [String]
		/// The policy clause that answered, when a rule did.
		let rule: String?
		let reason: String?
		let at: Double
	}

	/// One question of the queue, open or decided.
	struct Question: Decodable, Equatable, Sendable {
		/// Its ref, for example Q-12.
		let q: String
		/// adopt, map, failure, finding or signoff. The evidence is read by it.
		let kind: String
		let title: String
		/// Who produced the evidence: human, agent, ci or rule.
		let producer: String
		let state: String
		/// Read by `kind`, as one of the evidence shapes below.
		let evidence: JSONValue
		/// What an answer says it was given on. Sent back unchanged.
		let evidenceHash: String
		let seen: Seen
		/// Who the question waits for, as a sentence.
		let needs: String
		/// The answers that apply to this question, in the order the queue shows them.
		let answers: [String]
		/// The runs it is listed as blocking.
		let blocks: [String]
		let about: [String]
		let openedAt: Double
		let advice: [Advice]
		/// What the caller's answer would be worth: counts, advice or forbidden. In a listing only.
		let you: String?
		let decision: Decision?
	}

	/// `inbox`: a page of questions, and how many are open of each kind.
	struct Inbox: Decodable, Equatable, Sendable {
		/// Open questions by kind, and `open` for all of them. A kind with none is absent.
		let counts: [String: Int]
		let items: [Question]
		let cursor: String?
	}

	/// A test a question is about.
	struct TestRef: Decodable, Equatable, Sendable {
		/// Its ref, for example T-9.
		let t: String
		let name: String
		/// The case it is linked to, where it is.
		let `case`: String?
	}

	/// A failed result nobody has explained.
	struct FailureEvidence: Decodable, Equatable, Sendable {
		/// The failure as the runner reported it.
		let message: String?
		/// Where it was asked: a change (pr:482), the trunk, or a run.
		let scope: String
		/// The tests that share the cause: the first fifty.
		let tests: [TestRef]
		/// How many tests share the cause.
		let count: Int
		/// The commit, shortened, or what else was tested.
		let target: String
		let branch: String?
		/// What the server noticed: fails-on-base, disputed.
		let hints: [String]
		let facts: [String]
	}

	/// Tests of one file that have no case.
	struct MapEvidence: Decodable, Equatable, Sendable {
		let file: String
		let tests: [TestRef]
		let count: Int
		let facts: [String]
	}

	/// A case a finder suggests adding.
	struct SuggestedCase: Decodable, Equatable, Sendable {
		let title: String
		let steps: [String]
	}

	/// An edit a finder suggests: to one step, or a new case.
	struct Suggestion: Decodable, Equatable, Sendable {
		let action: String?
		let expected: String?
		let `case`: SuggestedCase?
	}

	/// What a review found.
	struct FindingEvidence: Decodable, Equatable, Sendable {
		/// Where: a case (C-311), a step (C-311#b7), a requirement or a change.
		let on: String
		let `case`: String?
		let caseTitle: String?
		let step: String?
		let category: String
		let note: String
		let repro: String?
		/// Accepting the finding turns it into a proposal by the finder.
		let suggest: Suggestion?
		let finder: String
		let lens: String
		let facts: [String]
	}

	/// One edit of a proposal in short. Which fields it carries depends on `op`.
	struct EditSummary: Decodable, Equatable, Sendable {
		/// create, edit, restore, place, state, folder, cover or policy.
		let op: String
		let `case`: String?
		let title: String?
		/// For place and state: how many cases.
		let cases: Int?
		/// For folder: its name.
		let name: String?
		/// For policy: the preset it changes to.
		let preset: String?
	}

	/// A case the edit cannot be merged into.
	struct EditConflict: Decodable, Equatable, Sendable {
		let `case`: String
		let paths: [String]
	}

	/// A proposed edit that waits for a person.
	struct AdoptEvidence: Decodable, Equatable, Sendable {
		let proposal: String
		let author: String
		let reason: String?
		/// The first twenty edits.
		let edits: [EditSummary]
		let count: Int
		let conflicts: [EditConflict]
		let facts: [String]
	}

	/// A run that can be closed.
	struct SignoffEvidence: Decodable, Equatable, Sendable {
		let run: String
		let name: String
		let verdict: String
		let tally: [String: Int]
		let facts: [String]
	}

	/// `decide`: what became of one answer, or of one withdrawal.
	struct DecideReply: Decodable, Equatable, Sendable {
		let q: String
		/// decided, advised, already, conflict, forbidden, invalid or reopened.
		let status: String
		/// Why not, or who decides instead, as a sentence.
		let needs: String?
		let decision: Int?
		/// On a conflict: the evidence the question has now.
		let evidence: String?
	}

	/// One step of a case.
	struct Step: Decodable, Equatable, Sendable {
		/// Short, unique within its case and never used again, so a result or an edit can name the step.
		let id: String
		let action: String
		/// What must be true afterwards, where the author said.
		let expected: String?
	}

	/// The content of a case that has versions.
	struct CaseBody: Decodable, Equatable, Sendable {
		let title: String
		/// Preconditions. Empty when there are none.
		let pre: String
		let steps: [Step]
		/// Who may produce evidence for the case: human, auto, agent.
		let methods: [String]
		/// Whether an automated test is wanted: none, wanted or not-applicable.
		let automate: String
		/// Custom field values. A case that is read alone leaves them out.
		let fields: [String: String]?
	}

	/// One edit of a proposal. Which fields it carries depends on `op`.
	struct ProposalEdit: Decodable, Equatable, Sendable {
		/// create, edit, restore, place, state, folder, cover or policy.
		let op: String
		let `case`: String?
		/// For create, edit and restore: the case as it would be.
		let body: CaseBody?
		/// For edit: the case as it is now.
		let current: CaseBody?
	}

	/// `get` with a P- ref: a proposed edit with the documents it would change.
	struct Proposal: Decodable, Equatable, Sendable {
		let ref: String
		let edits: [ProposalEdit]
	}

	/// One event of `GET /api/p/<project>/events`: something changed.
	struct ChangeEvent: Decodable, Equatable, Sendable {
		let project: String
		let seq: Int
		let op: String
		/// The refs the command touched. Empty does not mean nothing changed.
		let touched: [String]
	}
}
