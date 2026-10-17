// Written by `bun scripts/ios.ts gen` from src/core/kinds.ts, src/core/runs.ts, src/core/model.ts and src/core/ops.ts. Do not edit it: change that file and run the command again.

/// The words of the queue: what each answer is called and what it does, as every other client says them.
enum Vocabulary {
	/// The name of each answer, by the word the server knows it by.
	static let answerLabels: [String: String] = [
		"accept": "Accept",
		"reject": "Reject",
		"merge": "Merge",
		"link": "Link to a case",
		"create": "Create cases",
		"track": "Track without a case",
		"unlink": "Unlink",
		"defect": "Defect in the product",
		"test": "The test is wrong",
		"expected": "Expected: behaviour changed",
		"flaky": "Flaky",
		"infra": "Infrastructure",
		"inherited": "Already failing on base",
		"mistaken": "The failure was a mistake",
		"duplicate": "Duplicate",
		"defer": "Defer",
		"approve": "Approve",
		"withdrawn": "Withdrawn",
		"expired": "Expired",
		"outdated": "The evidence changed",
	]

	/// What each answer does, in a sentence, by the kind of question and the answer.
	static let answerHelp: [String: [String: String]] = [
		"adopt": [
			"accept": "Makes this the current version.",
			"reject": "Leaves the case as it is. The proposal stays in the history.",
			"merge": "Adopts the version you put together from both sides.",
		],
		"map": [
			"link": "Results of this test count for the case from now on.",
			"create": "Makes one case per test and links them.",
			"track": "Keeps them as tests without cases. They still gate the build.",
			"unlink": "The test stops counting for its case.",
		],
		"failure": [
			"defect": "A product bug. The gate fails until a build passes.",
			"test": "The test is wrong. The gate fails until the test is fixed.",
			"expected": "The behaviour changed on purpose. The gate fails until the case and the test say so.",
			"flaky": "Unreliable. Not blocking; asked again when the hold runs out or the evidence changes.",
			"infra": "The environment, not the product. Excused for this build only.",
			"inherited": "Already failing where this change started. Not this change's doing.",
			"mistaken": "The failing result was a mistake. The passing result stands.",
		],
		"finding": [
			"accept": "Agree. A suggestion it carries becomes a proposed edit by its author.",
			"reject": "Disagree. It is not raised again for this version.",
			"duplicate": "Already covered by another finding.",
			"defer": "Not now. It stays on record.",
		],
		"signoff": [
			"approve": "Closes the run with the verdict it has now.",
			"reject": "Leaves the run open.",
		],
	]

	/// What each kind of question is called, by the server's word for it: on a row's tag, on the queue's filter,
	/// and counted, one and several.
	static let kindWords: [String: (tag: String, filter: String, one: String, many: String)] = [
		"adopt": (tag: "proposal", filter: "Proposals", one: "proposal", many: "proposals"),
		"map": (tag: "unlinked", filter: "Unlinked", one: "unlinked test", many: "unlinked tests"),
		"failure": (tag: "failure", filter: "Failures", one: "failure", many: "failures"),
		"finding": (tag: "finding", filter: "Findings", one: "finding", many: "findings"),
		"signoff": (tag: "sign-off", filter: "Sign-offs", one: "sign-off", many: "sign-offs"),
	]
}

/// How many answers one `decide` request carries: the most one saved answer, and so one selection, holds.
package let decideMax = 500

/// How a commit's gate counts one result, problems first: the order `find --in results` lists them in.
public enum ResultStanding: String, CaseIterable, Sendable {
	case unexplained
	case attributed
	case excused
	case missing
	case skipped
	case pass

	/// What every client calls it.
	public var label: String {
		switch self {
		case .unexplained: "unexplained"
		case .attributed: "needs a fix"
		case .excused: "excused"
		case .missing: "could not run"
		case .skipped: "skipped"
		case .pass: "passed"
		}
	}
}

/// A way a case is run: by a person, by a pipeline's automated test, or by an agent.
public enum CaseMethod: String, CaseIterable, Sendable {
	case human
	case auto
	case agent

	/// What every client calls it.
	public var label: String {
		switch self {
		case .human: "Person"
		case .auto: "Pipeline"
		case .agent: "Agent"
		}
	}
}
