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

/// Where a merged change landed on trunk, when the server was told.
public enum ChangeLanding: Equatable, Sendable {
	/// It landed as its head: that commit is on trunk now, and the change's gate is that commit's, judged there.
	case asHead(branch: String)
	/// It landed as another commit, which has a gate of its own.
	case asCommit(LandedCommit)

	init?(_ wire: Wire.ChangeLanding?, head: String?) {
		guard let wire else { return nil }
		self = wire.commit == head ? .asHead(branch: wire.branch) : .asCommit(LandedCommit(wire))
	}
}

/// A commit a merge wrote on trunk, and its own gate.
public struct LandedCommit: Equatable, Sendable {
	public let commit: String
	public let branch: String
	public let verdict: ChangeVerdict
	public let reason: String
	/// The jobs that reported in shards and are missing some.
	public let waiting: [ShardWait]
	/// The run whose verdict this is. None: nothing a gate counts was reported for this commit.
	public let run: String?

	init(_ wire: Wire.ChangeLanding) {
		commit = wire.commit
		branch = wire.branch
		verdict = ChangeVerdict(wire.verdict)
		reason = wire.reason
		waiting = (wire.waiting ?? []).map(ShardWait.init)
		run = wire.run
	}
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
	/// The head's verdict.
	public let verdict: ChangeVerdict
	public let landing: ChangeLanding?

	init(_ wire: Wire.ChangeSummary) {
		key = wire.key
		title = wire.title ?? wire.key
		branch = wire.branch
		head = wire.head
		address = wire.url.flatMap(URL.init(string:))
		state = ChangeState(wire.state)
		verdict = ChangeVerdict(wire.verdict ?? "pending")
		landing = ChangeLanding(wire.landing, head: wire.head)
	}

	init(
		key: String, basis: Wire.ChangeBasis, gate: Wire.ChangeGate,
		header: Wire.ChangeRunHeader?, known: ChangeSummary?
	) {
		self.init(Wire.ChangeSummary(
			key: key, title: basis.title, branch: header?.branch ?? known?.branch, head: basis.head,
			url: header?.url ?? known?.address?.absoluteString,
			state: basis.state, verdict: gate.verdict, landing: basis.landing
		))
	}
}

public struct ChangeGate: Equatable, Sendable {
	public let verdict: ChangeVerdict
	public let reason: String
	/// The jobs that reported in shards and are missing some.
	public let waiting: [ShardWait]
	public let stale: Bool
	public let tally: [String: Int]
	/// The run whose verdict this is. None: nothing a gate counts was reported for the head.
	public let run: String?

	init(_ wire: Wire.ChangeGate) {
		verdict = ChangeVerdict(wire.verdict)
		reason = wire.reason
		waiting = (wire.waiting ?? []).map(ShardWait.init)
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
		try await details(of: change.key, known: change)
	}

	package func details(of change: String, known: ChangeSummary? = nil) async throws -> ChangeDetails {
		for _ in 0..<2 {
			if let detail = try await readChange(change, known: known) { return detail }
		}
		throw ChangeReadError.moved
	}

	private func readChange(_ change: String, known: ChangeSummary?) async throws -> ChangeDetails? {
		let affected: Wire.ChangeImpact = try await server.read("impact", in: key, ["change": .string(change)])
		async let gate: Wire.ChangeGate = server.read("gate", in: key, ["change": .string(change)])
		async let inbox: Wire.Inbox = server.read(
			"inbox", in: key, ["state": "open", "on": .string(change), "limit": 500]
		)
		let (status, questions) = try await (gate, inbox)
		guard affected.change.key == change, affected.gate?.run == status.run else { return nil }
		var failing: [ChangeFailure] = []
		var header: Wire.ChangeRunHeader?
		if let run = status.run {
			let rows: [Wire.ChangeRun] = try await server.read("get", in: key, ["refs": [.string(run)]])
			guard let row = rows.first, rows.count == 1, row.ref == run else { throw ClientError.unreadable }
			// The run's change may already name a later head. Its accepted commit owns these failures.
			guard row.accepts.commit == affected.change.head else { return nil }
			if let current = row.change, current.key == change {
				guard current.head == affected.change.head else { return nil }
				header = current
			}
			failing = (row.failing ?? []).map(ChangeFailure.init)
		}
		// Keep questions and gate reads between two replies that name the same head and run.
		let confirmed: Wire.ChangeImpact = try await server.read("impact", in: key, ["change": .string(change)])
		guard confirmed.change.key == change, confirmed.change.head == affected.change.head,
			confirmed.change.base == affected.change.base, confirmed.change.state == affected.change.state,
			confirmed.change.landing == affected.change.landing,
			confirmed.gate?.run == status.run else { return nil }
		return ChangeDetails(
			change: ChangeSummary(key: change, basis: affected.change, gate: status, header: header, known: known),
			base: affected.change.base, gate: ChangeGate(status),
			questions: questions.items.map(Question.init), failing: failing,
			cases: affected.cases.map(ChangedCase.init), caseCount: affected.counts.cases
		)
	}
}

package enum ChangeReadError: Error, LocalizedError {
	case moved

	package var errorDescription: String? {
		"This change moved while it was read. Pull down to read it again."
	}
}
