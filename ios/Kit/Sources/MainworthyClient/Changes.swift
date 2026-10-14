import Foundation

public enum ChangeVerdict: Equatable, Sendable {
	case passed, failed, blocked, pending
	case other(String)

	init(_ word: String) {
		switch word {
		case "passed": self = .passed
		case "failed": self = .failed
		case "blocked": self = .blocked
		case "pending": self = .pending
		default: self = .other(word)
		}
	}

	public var name: String {
		switch self {
		case .passed: "passed"
		case .failed: "failed"
		case .blocked: "blocked"
		case .pending: "pending"
		case .other(let word): word
		}
	}
}

public enum ChangeState: Equatable, Sendable {
	case open, merged, closed
	case other(String)

	init(_ word: String) {
		switch word {
		case "open": self = .open
		case "merged": self = .merged
		case "closed": self = .closed
		default: self = .other(word)
		}
	}

	public var name: String {
		switch self {
		case .open: "open"
		case .merged: "merged"
		case .closed: "closed"
		case .other(let word): word
		}
	}

	public var isEnded: Bool { self == .merged || self == .closed }
}

/// A branch or pull request for which a pipeline has reported results.
public struct ChangeSummary: Identifiable, Equatable, Sendable {
	public var id: String { key }
	public let key: String
	public let title: String
	public let branch: String?
	public let head: String?
	public let address: URL?
	public let state: ChangeState
	public let verdict: ChangeVerdict

	init(_ wire: Wire.ChangeSummary) {
		key = wire.key
		title = wire.title ?? wire.key
		branch = wire.branch
		head = wire.head
		address = wire.url.flatMap(URL.init(string:))
		state = ChangeState(wire.state)
		verdict = ChangeVerdict(wire.verdict ?? "pending")
	}
}

public struct ChangeGate: Equatable, Sendable {
	public let verdict: ChangeVerdict
	public let reason: String
	public let stale: Bool
	public let tally: [String: Int]
	package let run: String?

	init(_ wire: Wire.ChangeGate) {
		verdict = ChangeVerdict(wire.verdict)
		reason = wire.reason
		stale = wire.stale
		tally = wire.tally
		run = wire.run
	}

	/// The gate's counts, in words. A count the server adds later keeps its own label.
	public var phrase: String {
		let labels = ["pass": "passed", "excused": "excused", "attributed": "attributed",
			"unexplained": "unexplained", "missing": "missing", "disputed": "disputed", "skipped": "skipped"]
		let order = ["pass", "excused", "attributed", "unexplained", "missing", "disputed", "skipped"]
		let keys = order + tally.keys.filter { !order.contains($0) }.sorted()
		let counts = keys.compactMap { key -> String? in
			guard let count = tally[key], count > 0 else { return nil }
			return "\(count) \(labels[key] ?? key)"
		}
		return counts.isEmpty ? "No results counted" : counts.joined(separator: " · ")
	}
}

public struct ChangedCase: Identifiable, Equatable, Sendable {
	public let id: String
	public let title: String
	public let reasons: [String]
	public let lastResult: String?

	init(_ wire: Wire.ChangedCase) {
		id = wire.id
		title = wire.title
		reasons = wire.why
		lastResult = wire.last
	}
}

public struct ChangeFailure: Equatable, Sendable {
	public let test: String?
	public let name: String?
	public let file: String?
	public let caseRef: String?
	public let cause: String?

	init(_ wire: Wire.ChangeFailure) {
		test = wire.test
		name = wire.name
		file = wire.file
		caseRef = wire.case
		cause = wire.cause
	}
}

public struct ChangeDetails: Equatable, Sendable {
	public let change: ChangeSummary
	public let base: String?
	public let gate: ChangeGate
	public let questions: [Question]
	public let failing: [ChangeFailure]
	public let cases: [ChangedCase]
	public let caseCount: Int
}

extension ProjectClient {
	/// Changes is bounded by the server: it supplies no cursor. Read the largest supported set.
	package func reportedChanges() async throws -> [ChangeSummary] {
		let wire: Wire.ChangeList = try await server.read("find", in: key, ["in": "changes", "limit": 500])
		return wire.items.map(ChangeSummary.init)
	}

	package func details(of change: ChangeSummary) async throws -> ChangeDetails {
		async let gate: Wire.ChangeGate = server.read("gate", in: key, ["change": .string(change.key)])
		async let inbox: Wire.Inbox = server.read(
			"inbox", in: key, ["state": "open", "on": .string(change.key), "limit": 500]
		)
		async let impact: Wire.ChangeImpact = server.read("impact", in: key, ["change": .string(change.key)])
		let (status, questions, affected) = try await (gate, inbox, impact)
		var failing: [ChangeFailure] = []
		if let run = status.run {
			let rows: [Wire.ChangeRun] = try await server.read("get", in: key, ["refs": [.string(run)]])
			guard let row = rows.first else { throw ClientError.unreadable }
			failing = (row.failing ?? []).map(ChangeFailure.init)
		}
		return ChangeDetails(
			change: change, base: affected.change.base, gate: ChangeGate(status),
			questions: questions.items.map(Question.init), failing: failing,
			cases: affected.cases.map(ChangedCase.init), caseCount: affected.counts.cases
		)
	}
}
