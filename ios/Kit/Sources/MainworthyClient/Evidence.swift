import Foundation

/// What a question asks about, by its kind.
public enum Evidence: Equatable, Sendable {
	case failure(FailedResult)
	case unlinked(UnlinkedTests)
	case finding(Finding)
	case proposal(ProposedEdit)
	case signoff(RunToClose)
	/// Evidence this build cannot read: a kind the server added, or a shape it changed. The question is shown
	/// by its title, and the app does not offer to answer what it cannot show.
	case unreadable

	init(kind: Kind, _ wire: JSONValue) {
		let read: Evidence? =
			switch kind {
			case .failure: wire.read(as: Wire.FailureEvidence.self).map { .failure(FailedResult($0)) }
			case .map: wire.read(as: Wire.MapEvidence.self).map { .unlinked(UnlinkedTests($0)) }
			case .finding: wire.read(as: Wire.FindingEvidence.self).map { .finding(Finding($0)) }
			case .adopt: wire.read(as: Wire.AdoptEvidence.self).map { .proposal(ProposedEdit($0)) }
			case .signoff: wire.read(as: Wire.SignoffEvidence.self).map { .signoff(RunToClose($0)) }
			case .other: nil
			}
		self = read ?? .unreadable
	}
}

/// A test, by its ref and name, with the case it is linked to where it is.
public struct TestRef: Identifiable, Equatable, Sendable {
	public var id: String { ref }
	public let ref: String
	public let name: String
	public let caseRef: String?

	init(_ wire: Wire.TestRef) {
		ref = wire.t
		name = wire.name
		caseRef = wire.case
	}
}

/// A failed result nobody has explained yet. One question stands for every test that fails for the same cause.
public struct FailedResult: Equatable, Sendable {
	/// The failure as the runner reported it.
	public let message: String?
	/// What was expected and what was seen, when the message is an assertion that says both.
	public let comparison: Comparison?
	/// The tests that share the cause: the first fifty of `count`.
	public let tests: [TestRef]
	public let count: Int
	/// The commit, shortened, or what else was tested.
	public let target: String
	public let branch: String?
	/// The same cause also fails where this change started.
	public let failsOnBase: Bool
	/// A pass and a fail disagree about the same case.
	public let isDisputed: Bool

	public struct Comparison: Equatable, Sendable {
		public let expected: String
		public let observed: String
	}

	init(_ wire: Wire.FailureEvidence) {
		message = wire.message
		comparison = wire.message.flatMap(FailedResult.comparison)
		tests = wire.tests.map(TestRef.init)
		count = wire.count
		target = wire.target
		branch = wire.branch
		failsOnBase = wire.hints.contains("fails-on-base")
		isDisputed = wire.hints.contains("disputed")
	}

	/// Reads "expected A, got B", "expected A to equal B" and "A !== B". Any other message is shown as it is.
	/// The web reads the same three forms (`assertionComparison` in `src/web/queue/evidence.tsx`).
	static func comparison(in message: String) -> Comparison? {
		if let found = message.firstMatch(of: /(?i)\bexpected\s+(.+?),?\s+(?:but\s+)?(?:got|received)\s+(.+)/) {
			var expected = String(found.1).trimmingCharacters(in: .whitespaces)
			if expected.hasSuffix(",") { expected.removeLast() }
			return Comparison(expected: expected, observed: String(found.2).trimmingCharacters(in: .whitespaces))
		}
		if let found = message.firstMatch(of: /(?i)\bexpected\s+(.+?)\s+to\s+(?:equal|be)\s+(.+)/) {
			return Comparison(
				expected: String(found.2).trimmingCharacters(in: .whitespaces),
				observed: String(found.1).trimmingCharacters(in: .whitespaces)
			)
		}
		if let found = message.wholeMatch(of: /\s*(.+?)\s*!==\s*(.+?)\s*/) {
			return Comparison(expected: String(found.2), observed: String(found.1))
		}
		return nil
	}
}

/// Tests of one file that have no case.
public struct UnlinkedTests: Equatable, Sendable {
	public let file: String
	public let tests: [TestRef]
	public let count: Int

	init(_ wire: Wire.MapEvidence) {
		file = wire.file
		tests = wire.tests.map(TestRef.init)
		count = wire.count
	}
}

/// What a review found about a case, a step or a change.
public struct Finding: Equatable, Sendable {
	/// Where: a case (C-311), a step (C-311#b7), a requirement or a change.
	public let on: String
	public let caseRef: String?
	public let caseTitle: String?
	public let category: String
	public let note: String
	public let repro: String?
	public let suggestion: Suggestion?
	public let finder: String
	/// The kind of review: adversarial-review.
	public let lens: String

	/// The edit the finder suggests. Accepting the finding turns it into a proposal by the finder.
	public enum Suggestion: Equatable, Sendable {
		case step(action: String?, expected: String?)
		case newCase(title: String, steps: [String])
	}

	init(_ wire: Wire.FindingEvidence) {
		on = wire.on
		caseRef = wire.case
		caseTitle = wire.caseTitle
		category = wire.category
		note = wire.note
		repro = wire.repro
		finder = wire.finder
		lens = wire.lens
		suggestion = wire.suggest.flatMap { suggest -> Suggestion? in
			if let new = suggest.case { return .newCase(title: new.title, steps: new.steps) }
			return suggest.action == nil && suggest.expected == nil
				? nil : .step(action: suggest.action, expected: suggest.expected)
		}
	}
}

/// An edit somebody proposes, which waits for a person. Its documents are read apart (`ProjectClient.documents`).
public struct ProposedEdit: Equatable, Sendable {
	/// The proposal's ref, for example P-11.
	public let proposal: String
	public let author: String
	public let reason: String?
	/// What each edit does, in a line: the first twenty of `count`.
	public let summaries: [String]
	public let count: Int
	/// The cases the edit cannot be merged into, each with the fields that are in the way.
	public let conflicts: [Conflict]
	/// Whether this build shows everything the proposal changes: it does for a new case and for an edit to
	/// what a case says, whose documents it sets side by side. A proposal that restores an earlier version,
	/// moves, tags, archives or re-covers cases, makes a folder or changes the policy is answered in the web
	/// app.
	public let isShownWhole: Bool

	public struct Conflict: Equatable, Sendable {
		public let caseRef: String
		public let fields: [String]
	}

	init(_ wire: Wire.AdoptEvidence) {
		proposal = wire.proposal
		author = wire.author
		reason = wire.reason
		summaries = wire.edits.map(ProposedEdit.summary)
		count = wire.count
		conflicts = wire.conflicts.map { Conflict(caseRef: $0.case, fields: $0.paths) }
		// The summaries are the first twenty edits. A longer proposal is not known to be shown whole.
		isShownWhole =
			wire.count == wire.edits.count
			&& wire.edits.allSatisfy { ["create", "edit"].contains($0.op) }
	}

	/// One edit in a line, from the summary the server gives of it.
	private static func summary(_ edit: Wire.EditSummary) -> String {
		let named = [edit.case, edit.title].compactMap { $0 }.joined(separator: " · ")
		func cases(_ verb: String) -> String {
			let count = edit.cases ?? 0
			return "\(verb) \(count) \(count == 1 ? "case" : "cases")"
		}
		switch edit.op {
		case "create": return "New case: \(edit.title ?? "untitled")"
		case "edit": return "Edit \(named)"
		case "restore": return "Restore an earlier version of \(named)"
		case "cover": return "Change what \(named) covers"
		case "place": return cases("Move or tag")
		case "state": return cases("Archive or restore")
		case "folder": return edit.name.map { "Folder \($0)" } ?? "Change a folder"
		case "policy": return "Change the policy to \(edit.preset ?? "another one")"
		default: return edit.op.capitalized
		}
	}
}

/// A run that has passed and can be closed.
public struct RunToClose: Equatable, Sendable {
	public let run: String
	public let name: String
	/// passed, failed, blocked or pending.
	public let verdict: String
	/// What the run counts, by what it is: pass, missing, unexplained.
	public let tally: [String: Int]

	init(_ wire: Wire.SignoffEvidence) {
		run = wire.run
		name = wire.name
		verdict = wire.verdict
		tally = wire.tally
	}
}
