import Foundation

/// One test as a commit's gate counted it, with a case or tracked without one.
public struct CountedResult: Identifiable, Equatable, Sendable {
	/// A result is counted once for each job that reported it.
	public var id: String { "\(result):\(job)" }
	public let location: ResultLocation?
	public let result: Int
	/// The test's ref: T-9.
	public let test: String
	public let name: String
	public let file: String?
	/// The case the result counts for. None: the test is tracked without a case.
	public let caseRef: String?
	public let outcome: String
	/// How the gate counted it. Nil for a word this build does not know.
	public let standing: ResultStanding?
	public let quarantined: Bool
	/// The question its standing rests on, or the open one the gate waits for.
	public let question: String?
	public let attempt: Int
	public let duration: Double?
	public let message: String?
	public let job: String
	public let by: String
	public let model: String?
	public let steps: [ResultStep]?
	/// The CI build, when the report named a web address for it.
	public let build: URL?

	init(_ wire: Wire.CountedResult) {
		location = wire.location.map(ResultLocation.init)
		result = wire.result
		test = wire.test
		name = wire.name
		file = wire.file
		caseRef = wire.case
		outcome = wire.outcome
		standing = ResultStanding(rawValue: wire.standing)
		quarantined = wire.quarantined
		question = wire.question
		attempt = wire.attempt
		duration = wire.durationMs
		message = wire.message
		job = wire.job
		by = wire.by
		model = wire.model
		steps = wire.steps?.map(ResultStep.init)
		build = webAddress(wire.build)
	}
}

/// How long the results a gate counts took, as their reports said. Results that ran side by side add up, so this
/// is the time spent testing, not how long a build took.
public struct TestTime: Equatable, Sendable {
	public let ms: Int
	/// How many of the results named a duration.
	public let timed: Int
}

/// A page of what a change's gate counted, with the whole tally whatever the page holds.
package struct CountedPage: Equatable, Sendable {
	package let rows: [CountedResult]
	/// How many rows match the filter, when the server said.
	package let count: Int?
	/// Every row the gate counts, by standing.
	package let tally: [ResultStanding: Int]
	/// The summed duration of every row the gate counts.
	package let testTime: TestTime
	package let next: String?

	/// The results of a commit nothing a gate counts was reported for.
	package static let none = CountedPage(rows: [], count: 0, tally: [:], testTime: TestTime(ms: 0, timed: 0), next: nil)
}

/// An automated test the project has seen, with a case or without one.
public struct TestSummary: Identifiable, Equatable, Sendable {
	public var id: String { ref }
	public let ref: String
	public let name: String
	public let file: String?
	/// The case it is linked to. None: it is tracked without a case.
	public let caseRef: String?
	/// Why it is quarantined, while it is.
	public let quarantine: String?

	init(_ wire: Wire.TestSummary) {
		ref = wire.ref
		name = wire.name
		file = wire.file
		caseRef = wire.case
		quarantine = wire.quarantine.flatMap { $0.active ? $0.reason : nil }
	}
}

package struct TestPage: Equatable, Sendable {
	package let rows: [TestSummary]
	package let next: String?
}

/// A test and its latest results, newest first.
public struct TestDetail: Equatable, Sendable {
	public struct Result: Identifiable, Equatable, Sendable {
		public let id: Int
		public let outcome: String
		public let by: String
		public let model: String?
		public let steps: [ResultStep]?
		public let at: Date
		public let attempt: Int
		public let duration: Double?
		public let message: String?
		public let location: ResultLocation?
		public let commit: String?
		/// The change the commit was reported for: pr:482.
		public let change: String?
		public let job: String
		public let build: URL?
	}

	public let ref: String
	public let key: String
	public let name: String
	public let file: String?
	public let caseRef: String?
	/// How often it flipped between passing and failing on the same code.
	public let flips: Int
	public let quarantine: String?
	public let results: [Result]

	init(_ wire: Wire.TestDetail) {
		ref = wire.ref
		key = wire.key
		name = wire.name
		file = wire.file
		caseRef = wire.case
		flips = wire.flips
		quarantine = wire.quarantine.flatMap { $0.active ? $0.reason : nil }
		results = wire.last.map {
			Result(
				id: $0.id, outcome: $0.outcome, by: $0.by, model: $0.model, steps: $0.steps?.map(ResultStep.init),
				at: Date(milliseconds: $0.at), attempt: $0.attempt,
				duration: $0.durationMs, message: $0.message, location: $0.location.map(ResultLocation.init),
				commit: $0.commit, change: $0.change, job: $0.job,
				build: webAddress($0.build)
			)
		}
	}
}

/// A report names its build's address, and only a web address is offered as a link.
private func webAddress(_ text: String?) -> URL? {
	guard let text, let url = URL(string: text), let scheme = url.scheme?.lowercased(),
		scheme == "http" || scheme == "https" else { return nil }
	return url
}

/// A page that was asked for after the list it continues changed: a retry, a decision or a link moved a row.
/// The server refuses it rather than skip or repeat that row, and the list is read again from its start.
package struct ResultsMoved: Error, Equatable, Sendable {}

extension ProjectClient {
	/// A page of what a gate's run counted, problems first. The run is the one a change's gate names, so the
	/// results are of the commit whose verdict is shown, even after the change has a newer head.
	package func results(
		of run: String, standing: ResultStanding? = nil, text: String = "", after cursor: String? = nil
	) async throws -> CountedPage {
		var input: [String: JSONValue] = ["in": "results", "run": .string(run), "limit": 100]
		if let standing { input["state"] = .string(standing.rawValue) }
		let words = findText(text)
		if !words.isEmpty { input["text"] = .string(words) }
		if let cursor { input["cursor"] = .string(cursor) }
		let wire: Wire.CountedResults
		do {
			wire = try await server.read("find", in: key, .object(input))
		} catch ClientError.refused(code: "conflict", _) where cursor != nil {
			throw ResultsMoved()
		}
		var tally: [ResultStanding: Int] = [:]
		for (word, count) in wire.tally {
			if let standing = ResultStanding(rawValue: word) { tally[standing] = count }
		}
		return CountedPage(
			rows: wire.items.map(CountedResult.init), count: wire.count, tally: tally,
			testTime: TestTime(ms: wire.testTime.ms, timed: wire.testTime.timed), next: wire.cursor
		)
	}

	/// A page of the automated tests, newest first.
	package func tests(text: String = "", unlinked: Bool = false, after cursor: String? = nil) async throws -> TestPage {
		var input: [String: JSONValue] = ["in": "tests", "limit": 100]
		let words = findText(text)
		if !words.isEmpty { input["text"] = .string(words) }
		if unlinked { input["unlinked"] = true }
		if let cursor { input["cursor"] = .string(cursor) }
		let wire: Wire.TestList = try await server.read("find", in: key, .object(input))
		return TestPage(rows: wire.items.map(TestSummary.init), next: wire.cursor)
	}

	/// One test and its latest results, or nil when the project has no such test.
	package func test(_ ref: String) async throws -> TestDetail? {
		let rows: [Wire.TestDetail]
		do {
			rows = try await server.read("get", in: key, ["refs": [.string(ref)]])
		} catch ClientError.refused(code: "not_found", _) {
			return nil
		}
		guard let row = rows.first else { return nil }
		guard rows.count == 1, row.ref == ref else { throw ClientError.unreadable }
		return TestDetail(row)
	}
}

/// `find.text` accepts 200 characters, counted as code points. Sending at most 200 UTF-16 units stays inside that
/// for any text; keep whole characters when a paste crosses the boundary.
package func findText(_ text: String) -> String {
	var units = 0
	return String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix { character in
		units += String(character).utf16.count
		return units <= 200
	})
}
