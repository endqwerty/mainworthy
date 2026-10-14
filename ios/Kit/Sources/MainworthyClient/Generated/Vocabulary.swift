// Written by `bun scripts/ios.ts gen` from src/core/kinds.ts. Do not edit it: change that file and run the command again.

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
}
