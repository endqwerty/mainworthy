// Written by `bun scripts/ios.ts gen` from scripts/ios/contract.ts. Do not edit it: change that file and run the command again.

/// The server's replies, as far as the app reads them. A field the server sends and the app does not read is
/// not here. Nothing outside this module sees these types: each is turned into one of the app's own where
/// it is decoded.
enum Wire {
	/// Whether a password completed sign-in or needs a second step.
	struct SignInReply: Decodable, Equatable, Sendable {
		let signedIn: Bool
	}

	/// The name offered on the sign-in button.
	struct Provider: Decodable, Equatable, Sendable {
		let name: String
	}

	/// The configured identity provider, if any.
	struct SignInMethods: Decodable, Equatable, Sendable {
		let oidc: Provider?

		private enum CodingKeys: String, CodingKey { case oidc }

		init(from decoder: any Decoder) throws {
			let container = try decoder.container(keyedBy: CodingKeys.self)
			oidc = try container.decode(Provider?.self, forKey: .oidc)
		}
	}

	/// The provider authorization URL for a native sign-in.
	struct ProviderStart: Decodable, Equatable, Sendable {
		let url: String
	}

	/// A project the caller holds a grant on.
	struct Project: Decodable, Equatable, Sendable {
		/// The opaque identity of this project, retained across export and import.
		let identity: String
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
		/// The caller's stable actor id. A new person reusing a forgotten name has another id.
		let actorId: Int
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

	/// The answer an ending supersedes, with its original attribution.
	struct PriorDecision: Decodable, Equatable, Sendable {
		let id: Int
		let answer: GivenAnswer
		/// Who signed it.
		let by: [String]
		/// The policy clause that answered, when a rule did.
		let rule: String?
		let reason: String?
		let at: Double
	}

	/// A question's decision, or the ending of its answer.
	struct Decision: Decodable, Equatable, Sendable {
		let id: Int
		let answer: GivenAnswer
		/// Who signed it.
		let by: [String]
		/// The policy clause that answered, when a rule did.
		let rule: String?
		let reason: String?
		let at: Double
		let supersedes: PriorDecision?
	}

	/// One question of the queue, open, decided or dissolved.
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
		/// The folder the case would go into.
		let folder: String?
		let steps: [String]
	}

	/// An edit a finder suggests: to one step, or a new case.
	struct Suggestion: Decodable, Equatable, Sendable {
		/// The step the edit is made to. Where absent, the step the finding is on.
		let step: String?
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
		let addresses: [ConflictAddress]
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

	/// `decide`: one reply per answer or withdrawal, in request order.
	struct DecideReply: Decodable, Equatable, Sendable {
		/// The question this reply answers, including in a selection withdrawal.
		let q: String
		/// decided, advised, already, conflict, forbidden, invalid or reopened.
		let status: String
		/// Why not, or who decides instead, as a sentence.
		let needs: String?
		let decision: Int?
		/// On a conflict: the evidence the question has now.
		let evidence: String?
	}

	/// The recorded reply of a saved answer's command.
	struct AnswerCommand: Decodable, Equatable, Sendable {
		let state: String
		let reply: [DecideReply]?
	}

	/// The exact fragment version a step pins.
	struct FragmentPin: Decodable, Equatable, Sendable {
		let fragment: String
		let version: Int
	}

	/// One step of a case.
	struct Step: Decodable, Equatable, Sendable {
		/// Short, unique within its case and never used again, so a result or an edit can name the step.
		let id: String
		let use: FragmentPin?
		let action: String
		/// What must be true afterwards. Null where the author has not said; never left out.
		let expected: String?

		private enum CodingKeys: String, CodingKey { case id, use, action, expected }

		init(from decoder: any Decoder) throws {
			let container = try decoder.container(keyedBy: CodingKeys.self)
			id = try container.decode(String.self, forKey: .id)
			use = try container.decodeIfPresent(FragmentPin.self, forKey: .use)
			action = try container.decode(String.self, forKey: .action)
			expected = try container.decode(String?.self, forKey: .expected)
		}
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
		/// Custom field values. All of a case's content is here, so an edit is shown whole.
		let fields: [String: String]
	}

	/// One edit of a proposal. Which fields it carries depends on `op`.
	struct ProposalEdit: Decodable, Equatable, Sendable {
		/// create, edit, restore, place, state, folder, cover or policy.
		let op: String
		let `case`: String?
		/// For create, edit and restore: the case as it would be. For an edit while the proposal waits: the edit applied
		/// to the case as it is now, unless `refused`; then, and once decided, as it was proposed.
		let body: CaseBody?
		/// For edit and restore: the case as it is now.
		let current: CaseBody?
		/// For create: the path of the folder the case goes into.
		let folder: String?
		/// For create: the case's tags, a list of words. Another edit writes it otherwise.
		let tags: JSONValue?
		/// For create: the requirements the case covers.
		let covers: [String]?
		/// For edit, while the proposal waits: why accepting this edit on its own would be refused now, as a sentence.
		/// Null when nothing is found; the proposal's other edits can still refuse it.
		let refused: String?
	}

	/// `get` with a P- ref: a proposed edit with the documents it would change.
	struct Proposal: Decodable, Equatable, Sendable {
		let ref: String
		let edits: [ProposalEdit]
	}

	/// The complete edit and the current document.
	struct ConflictEdit: Decodable, Equatable, Sendable {
		let op: String
		let `case`: String?
		let base: Int
		let mine: CaseBody
		let current: CaseBody
	}

	/// One edit that the author resolves.
	struct ConflictProposal: Decodable, Equatable, Sendable {
		let ref: String
		let edits: [ConflictEdit]
	}

	/// The fields before this comparison.
	struct ConflictCustomFields: Decodable, Equatable, Sendable {
		let before: [String: String]
	}

	/// The complete custom fields, including when unchanged.
	struct ConflictBaseDiff: Decodable, Equatable, Sendable {
		let fields: ConflictCustomFields
	}

	/// Custom fields at the exact base version, from history.
	struct ConflictBaseFields: Decodable, Equatable, Sendable {
		let ref: String
		let from: Int
		let to: Int
		let diff: ConflictBaseDiff
	}

	/// An adopted version.
	struct MergeStamp: Decodable, Equatable, Sendable {
		let ref: String
		let version: Int
	}

	/// The server's result of the resolved proposal.
	struct MergeEffects: Decodable, Equatable, Sendable {
		let status: String
		let cases: [MergeStamp]
		let adopt: String?
		let proposal: String?
	}

	/// One decide reply, with the effect of a merge.
	struct MergeReply: Decodable, Equatable, Sendable {
		let q: String
		let status: String
		let needs: String?
		let effects: MergeEffects?
	}

	/// The recorded reply of a merge command.
	struct MergeCommand: Decodable, Equatable, Sendable {
		let state: String
		let reply: [MergeReply]?
	}

	/// One event of `GET /api/p/<project>/events`: something changed.
	struct ChangeEvent: Decodable, Equatable, Sendable {
		let project: String
		let seq: Int
		let op: String
		/// The refs the command touched. Empty does not mean nothing changed.
		let touched: [String]
	}

	/// The change a change run's commit belongs to.
	struct RunChange: Decodable, Equatable, Sendable {
		let key: String
		let title: String?
	}

	/// Only this run, or a commit's results.
	struct RunTarget: Decodable, Equatable, Sendable {
		let `self`: Bool?
		let commit: String?
		let repo: String?
		let env: String?
	}

	/// A planned run or a change run, with the server's verdict.
	struct Run: Decodable, Equatable, Sendable {
		let ref: String
		let name: String
		/// planned, or change: the run of one reported commit.
		let origin: String
		let state: String
		let verdict: String
		let reason: String
		/// Milliseconds since 1970.
		let createdAt: Int
		/// A planned run's pinned cases.
		let slots: Int?
		let inProgress: Int
		let workUntil: Int?
		let change: RunChange?
		let tally: [String: Int]
		let accepts: RunTarget
	}

	/// A page of runs, newest first.
	struct RunPage: Decodable, Equatable, Sendable {
		let items: [Run]
		let cursor: String?
	}

	/// One action taken while executing a case step.
	struct ResultAction: Decodable, Equatable, Sendable {
		let text: String
		let outcome: ResultOutcome?
		let durationMs: Int?
	}

	/// A recorded step, with its stable case ID or runner label.
	struct ResultStep: Decodable, Equatable, Sendable {
		let step: String
		let outcome: ResultOutcome
		let durationMs: Int?
		let actions: [ResultAction]?
		/// Zero-based index into this result's ordered attachments.
		let attachment: Int?
	}

	/// An admitted result that fills a slot.
	struct RunFill: Decodable, Equatable, Sendable {
		let model: String?
		let result: Int
		let by: String
		let method: String
		let outcome: String
		let note: String?
		let atStep: String?
		let steps: [ResultStep]?

		private enum CodingKeys: String, CodingKey { case model, result, by, method, outcome, note, atStep, steps }

		init(from decoder: any Decoder) throws {
			let container = try decoder.container(keyedBy: CodingKeys.self)
			model = try container.decodeIfPresent(String.self, forKey: .model)
			result = try container.decode(Int.self, forKey: .result)
			by = try container.decode(String.self, forKey: .by)
			method = try container.decode(String.self, forKey: .method)
			outcome = try container.decode(String.self, forKey: .outcome)
			note = try container.decodeIfPresent(String.self, forKey: .note)
			atStep = try container.decodeIfPresent(String.self, forKey: .atStep)
			steps = try container.decode([ResultStep]?.self, forKey: .steps)
		}
	}

	/// Free or held until the server deadline.
	struct SlotWork: Decodable, Equatable, Sendable {
		let kind: String
		let actor: String?
		let since: Int?
		let until: Int?
	}

	/// One case pinned at a version in a run, in order.
	struct RunSlot: Decodable, Equatable, Sendable {
		let id: Int
		let `case`: String?
		let title: String?
		let version: Int
		let state: String
		let fills: [RunFill]
		let work: SlotWork
	}

	/// A page of slots in their planned order.
	struct SlotPage: Decodable, Equatable, Sendable {
		let items: [RunSlot]
		let cursor: String?
	}

	/// The content at the slot's pinned version.
	struct PinnedCase: Decodable, Equatable, Sendable {
		let ref: String
		let version: Int
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

	/// A folder path.
	struct RunFolder: Decodable, Equatable, Sendable {
		let path: String
	}

	/// The folders a run can select.
	struct RunFolders: Decodable, Equatable, Sendable {
		let items: [RunFolder]
	}

	/// The run made by a plan.
	struct RunPlanReply: Decodable, Equatable, Sendable {
		let run: String
		let slots: Int
		let already: Int
	}

	/// The recorded reply of a captured plan's command.
	struct RunPlanCommand: Decodable, Equatable, Sendable {
		let state: String
		let reply: RunPlanReply?
	}

	/// The runnable case count for a plan selection.
	struct RunCaseCount: Decodable, Equatable, Sendable {
		let count: Int
	}

	/// Why one result was not recorded.
	struct ReportRefusal: Decodable, Equatable, Sendable {
		let reason: String
	}

	/// What became of a small manual report.
	struct RunReportReply: Decodable, Equatable, Sendable {
		let rejected: [ReportRefusal]
		let declined: [ReportRefusal]
		let results: [Int]
	}

	/// The recorded reply of a captured report's command.
	struct RunReportCommand: Decodable, Equatable, Sendable {
		let state: String
		let reply: RunReportReply?
	}

	/// A reported branch or pull request.
	struct ChangeSummary: Decodable, Equatable, Sendable {
		let key: String
		let title: String?
		let branch: String?
		let head: String?
		let url: String?
		let state: String
		let verdict: String?
	}

	/// `find` in changes: newest first, with the head's gate.
	struct ChangeList: Decodable, Equatable, Sendable {
		let items: [ChangeSummary]
	}

	/// `gate` of a change's head commit.
	struct ChangeGate: Decodable, Equatable, Sendable {
		let run: String?
		let verdict: String
		let reason: String
		let tally: [String: Int]
		let stale: Bool
	}

	/// The change and commits the affected cases were read for.
	struct ChangeBasis: Decodable, Equatable, Sendable {
		let key: String
		let head: String?
		let base: String?
		let title: String?
		/// Open, merged or closed, as it is now: a change older than the list's newest is read here.
		let state: String
	}

	/// The run counted for this head, if any.
	struct ChangeImpactGate: Decodable, Equatable, Sendable {
		let run: String?
	}

	/// The complete number of affected cases.
	struct ChangeImpactCounts: Decodable, Equatable, Sendable {
		let cases: Int
	}

	/// An affected case and why it is in the set.
	struct ChangedCase: Decodable, Equatable, Sendable {
		let id: String
		let title: String
		let why: [String]
		let last: String?
	}

	/// `impact` of a change: its base and the cases it touches.
	struct ChangeImpact: Decodable, Equatable, Sendable {
		let change: ChangeBasis
		let gate: ChangeImpactGate?
		let counts: ChangeImpactCounts
		let cases: [ChangedCase]
	}

	/// The commit this run actually counts, not the change's current head.
	struct ChangeRunTarget: Decodable, Equatable, Sendable {
		let commit: String
	}

	/// The change as it is now, which may have moved beyond this run.
	struct ChangeRunHeader: Decodable, Equatable, Sendable {
		let key: String
		let head: String?
		let branch: String?
		let url: String?
	}

	/// A failed test with its linked case, if any.
	struct ChangeFailure: Decodable, Equatable, Sendable {
		let test: String?
		let name: String?
		let file: String?
		let `case`: String?
		let cause: String?
	}

	/// `get` of the head's run: the first fifty failing tests.
	struct ChangeRun: Decodable, Equatable, Sendable {
		let ref: String
		let accepts: ChangeRunTarget
		let change: ChangeRunHeader?
		let failing: [ChangeFailure]?
	}

	/// One test as the gate counted it.
	struct CountedResult: Decodable, Equatable, Sendable {
		let model: String?
		let steps: [ResultStep]?
		let result: Int
		/// The test's ref, T-9.
		let test: String
		let name: String
		let file: String?
		/// The case the result claimed, else the one its test is linked to. None: tracked without one.
		let `case`: String?
		let outcome: String
		/// How the gate counted it: unexplained, attributed, excused, missing, skipped or pass.
		let standing: String
		let quarantined: Bool
		/// The question its standing rests on, or the open one the gate waits for.
		let question: String?
		let attempt: Int
		let durationMs: Double?
		let message: String?
		let job: String
		let by: String
		/// Where the CI build is, as the report named it.
		let build: String?

		private enum CodingKeys: String, CodingKey { case model, steps, result, test, name, file, `case`, outcome, standing, quarantined, question, attempt, durationMs, message, job, by, build }

		init(from decoder: any Decoder) throws {
			let container = try decoder.container(keyedBy: CodingKeys.self)
			model = try container.decodeIfPresent(String.self, forKey: .model)
			steps = try container.decode([ResultStep]?.self, forKey: .steps)
			result = try container.decode(Int.self, forKey: .result)
			test = try container.decode(String.self, forKey: .test)
			name = try container.decode(String.self, forKey: .name)
			file = try container.decodeIfPresent(String.self, forKey: .file)
			`case` = try container.decodeIfPresent(String.self, forKey: .case)
			outcome = try container.decode(String.self, forKey: .outcome)
			standing = try container.decode(String.self, forKey: .standing)
			quarantined = try container.decode(Bool.self, forKey: .quarantined)
			question = try container.decodeIfPresent(String.self, forKey: .question)
			attempt = try container.decode(Int.self, forKey: .attempt)
			durationMs = try container.decodeIfPresent(Double.self, forKey: .durationMs)
			message = try container.decodeIfPresent(String.self, forKey: .message)
			job = try container.decode(String.self, forKey: .job)
			by = try container.decode(String.self, forKey: .by)
			build = try container.decodeIfPresent(String.self, forKey: .build)
		}
	}

	/// `find` in results: what a commit's gate counted, a page.
	struct CountedResults: Decodable, Equatable, Sendable {
		/// How many rows match the filter.
		let count: Int?
		let items: [CountedResult]
		let cursor: String?
		/// Every row the gate counts, by standing, whatever the filter.
		let tally: [String: Int]
	}

	/// A result's attachment metadata.
	struct Attachment: Decodable, Equatable, Sendable {
		let id: Int
		let result: Int
		let name: String
		let type: String
		let at: String?
	}

	/// The attachment operation's ordered list.
	struct AttachmentList: Decodable, Equatable, Sendable {
		let kind: String
		let items: [Attachment]
	}

	/// One attachment and its base64 data.
	struct AttachmentFile: Decodable, Equatable, Sendable {
		let kind: String
		let attachment: Attachment
		let data: String
	}

	/// A quarantine a test is or was in.
	struct TestQuarantine: Decodable, Equatable, Sendable {
		let active: Bool
		let reason: String
	}

	/// One automated test.
	struct TestSummary: Decodable, Equatable, Sendable {
		let ref: String
		let name: String
		let file: String?
		/// The case it is linked to. None: tracked without one.
		let `case`: String?
		let quarantine: TestQuarantine?
	}

	/// `find` in tests: the automated tests a project has seen.
	struct TestList: Decodable, Equatable, Sendable {
		let items: [TestSummary]
		let cursor: String?
	}

	/// One of a test's latest results, newest first.
	struct TestResult: Decodable, Equatable, Sendable {
		let model: String?
		let steps: [ResultStep]?
		let id: Int
		let outcome: String
		let by: String
		let at: Double
		let attempt: Int
		let durationMs: Double?
		let message: String?
		let commit: String?
		let change: String?
		let job: String
		let build: String?

		private enum CodingKeys: String, CodingKey { case model, steps, id, outcome, by, at, attempt, durationMs, message, commit, change, job, build }

		init(from decoder: any Decoder) throws {
			let container = try decoder.container(keyedBy: CodingKeys.self)
			model = try container.decodeIfPresent(String.self, forKey: .model)
			steps = try container.decode([ResultStep]?.self, forKey: .steps)
			id = try container.decode(Int.self, forKey: .id)
			outcome = try container.decode(String.self, forKey: .outcome)
			by = try container.decode(String.self, forKey: .by)
			at = try container.decode(Double.self, forKey: .at)
			attempt = try container.decode(Int.self, forKey: .attempt)
			durationMs = try container.decodeIfPresent(Double.self, forKey: .durationMs)
			message = try container.decodeIfPresent(String.self, forKey: .message)
			commit = try container.decodeIfPresent(String.self, forKey: .commit)
			change = try container.decodeIfPresent(String.self, forKey: .change)
			job = try container.decode(String.self, forKey: .job)
			build = try container.decodeIfPresent(String.self, forKey: .build)
		}
	}

	/// `get` with a T- ref: a test and its latest results.
	struct TestDetail: Decodable, Equatable, Sendable {
		let ref: String
		let key: String
		let name: String
		let file: String?
		let `case`: String?
		/// How often it flipped between passing and failing on the same code.
		let flips: Int
		let quarantine: TestQuarantine?
		let last: [TestResult]
	}

	/// `session` list: one of the caller's living sessions.
	struct SessionRow: Decodable, Equatable, Sendable {
		let id: Int
		let openedWith: String
		let label: String
		let userAgent: String?
		let createdAt: Double
		let createdFrom: String?
		let lastUsedAt: Double
		let lastUsedFrom: String?
		let expiresAt: Double
		let current: Bool
	}

	/// `session` end: whether it ended, and whether it was this device's.
	struct SessionEnd: Decodable, Equatable, Sendable {
		let ended: Bool
		let current: Bool
	}

	/// `admin` token.list: identity and use, without the secret.
	struct TokenRow: Decodable, Equatable, Sendable {
		let id: Int
		let actor: String
		let kind: String
		let label: String
		let createdAt: Double
		let createdBy: String?
		let expiresAt: Double?
		let expired: Bool
		let lastUsedAt: Double?
		let lastUsedFrom: String?
		let revoked: Bool

		private enum CodingKeys: String, CodingKey { case id, actor, kind, label, createdAt, createdBy, expiresAt, expired, lastUsedAt, lastUsedFrom, revoked }

		init(from decoder: any Decoder) throws {
			let container = try decoder.container(keyedBy: CodingKeys.self)
			id = try container.decode(Int.self, forKey: .id)
			actor = try container.decode(String.self, forKey: .actor)
			kind = try container.decode(String.self, forKey: .kind)
			label = try container.decode(String.self, forKey: .label)
			createdAt = try container.decode(Double.self, forKey: .createdAt)
			createdBy = try container.decode(String?.self, forKey: .createdBy)
			expiresAt = try container.decode(Double?.self, forKey: .expiresAt)
			expired = try container.decode(Bool.self, forKey: .expired)
			lastUsedAt = try container.decode(Double?.self, forKey: .lastUsedAt)
			lastUsedFrom = try container.decode(String?.self, forKey: .lastUsedFrom)
			revoked = try container.decode(Bool.self, forKey: .revoked)
		}
	}

	/// `admin` token.revoke: true when this command revoked it.
	struct TokenRevoke: Decodable, Equatable, Sendable {
		let revoked: Bool
	}

	/// The latest evidence of one method, not a gate verdict.
	struct SuiteProof: Decodable, Equatable, Sendable {
		let outcome: String
		let current: Bool
	}

	/// The latest evidence by method.
	struct SuiteProofs: Decodable, Equatable, Sendable {
		let human: SuiteProof?
		let auto: SuiteProof?
		let agent: SuiteProof?
	}

	/// One case in the suite.
	struct SuiteCase: Decodable, Equatable, Sendable {
		let ref: String
		let title: String
		let tags: [String]
		let proof: SuiteProofs
	}

	/// A page of cases from find.
	struct SuiteCases: Decodable, Equatable, Sendable {
		let items: [SuiteCase]
		let cursor: String?
	}

	/// One folder and its direct case count.
	struct SuiteFolder: Decodable, Equatable, Sendable {
		let id: Int
		let parent: Int?
		let name: String
		let path: String
		let state: String
		let cases: Int
	}

	/// The project's folders from find.
	struct SuiteFolders: Decodable, Equatable, Sendable {
		let items: [SuiteFolder]
	}

	/// One tag and its active case count.
	struct SuiteTag: Decodable, Equatable, Sendable {
		let tag: String
		let n: Int
	}

	/// The project's tags from find.
	struct SuiteTags: Decodable, Equatable, Sendable {
		let items: [SuiteTag]
	}

	/// The current folder, even when reading an older version.
	struct SuitePlace: Decodable, Equatable, Sendable {
		let path: String
	}

	/// A case from get, at the version that was requested.
	struct SuiteDocument: Decodable, Equatable, Sendable {
		let kind: String?
		let hasFragments: Bool?
		let ref: String
		let version: Int
		let title: String
		let pre: String
		let steps: [Step]
		let methods: [String]
		let automate: String
		let fields: [String: String]?
		let tags: [String]
		let folder: SuitePlace
	}

	/// Who wrote a version, when, and why.
	struct SuiteVersion: Decodable, Equatable, Sendable {
		let version: Int
		let by: String
		let at: Double
		let reason: String?
		let summary: String
	}

	/// The versions of a case, newest first.
	struct SuiteHistory: Decodable, Equatable, Sendable {
		let versions: [SuiteVersion]
	}

	/// A case version the proposal made.
	struct SuiteStamp: Decodable, Equatable, Sendable {
		let ref: String
		let version: Int
	}

	/// The fields where edits overlap.
	struct SuiteConflict: Decodable, Equatable, Sendable {
		let `case`: String
		let addresses: [ConflictAddress]
	}

	/// What came of creating or editing a case.
	struct SuiteProposeReply: Decodable, Equatable, Sendable {
		let status: String
		let question: String?
		let needs: String?
		let cases: [SuiteStamp]
		let conflicts: [SuiteConflict]
	}
}
