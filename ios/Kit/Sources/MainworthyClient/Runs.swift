import Foundation

public enum RunVerdict: Equatable, Sendable {
	case passed, failed, blocked, pending, other(String)
	public var word: String {
		switch self {
		case .passed: "passed"
		case .failed: "failed"
		case .blocked: "blocked"
		case .pending: "pending"
		case .other(let word): word
		}
	}
	init(_ word: String) {
		self =
			switch word {
			case "passed": .passed
			case "failed": .failed
			case "blocked": .blocked
			case "pending": .pending
			default: .other(word)
			}
	}
}

public enum RunState: Equatable, Sendable {
	case open, closed, other(String)
	public var word: String {
		switch self {
		case .open: "open"
		case .closed: "closed"
		case .other(let word): word
		}
	}
	init(_ word: String) {
		self =
			switch word {
			case "open": .open
			case "closed": .closed
			default: .other(word)
			}
	}
}

public enum SlotState: Equatable, Sendable {
	case missing, satisfied, failing, disputed, waived, skipped, other(String)
	public var word: String {
		switch self {
		case .missing: "missing"
		case .satisfied: "satisfied"
		case .failing: "failing"
		case .disputed: "disputed"
		case .waived: "waived"
		case .skipped: "skipped"
		case .other(let word): word
		}
	}
	init(_ word: String) {
		self =
			switch word {
			case "missing": .missing
			case "satisfied": .satisfied
			case "failing": .failing
			case "disputed": .disputed
			case "waived": .waived
			case "skipped": .skipped
			default: .other(word)
			}
	}
}

public enum ManualOutcome: String, CaseIterable, Sendable {
	case pass, fail, blocked, skip
	public var label: String { rawValue.capitalized }
}

public enum FilledOutcome: Equatable, Sendable {
	case manual(ManualOutcome), error, other(String)
	public var word: String {
		switch self {
		case .manual(let outcome): outcome.rawValue
		case .error: "error"
		case .other(let word): word
		}
	}
	init(_ word: String) {
		if let known = ManualOutcome(rawValue: word) {
			self = .manual(known)
		} else {
			self = word == "error" ? .error : .other(word)
		}
	}
}

public enum FillMethod: Equatable, Sendable {
	case person, pipeline, agent, other(String)
	public var name: String {
		switch self {
		case .person: "person"
		case .pipeline: "pipeline"
		case .agent: "agent"
		case .other(let word): word
		}
	}
	init(_ word: String) {
		self =
			switch word {
			case "human": .person
			case "auto": .pipeline
			case "agent": .agent
			default: .other(word)
			}
	}
}

public struct PlannedRun: Identifiable, Equatable, Sendable {
	public var id: String { ref }
	public let ref: String
	public let name: String
	public let state: RunState
	public let verdict: RunVerdict
	public let reason: String
	public let tally: [String: Int]
	public let accepts: AcceptedResults
	public let slots: Int?
	/// Missing jobs are part of the tally too. Only the slot counts say how many cases remain.
	public var left: Int? {
		guard let slots else { return nil }
		let filled = ["pass", "excused", "attributed", "unexplained", "disputed", "skipped"]
			.reduce(0) { $0 + (tally[$1] ?? 0) }
		return max(0, slots - filled)
	}
	public var tallyText: String {
		let names = ["pass", "excused", "attributed", "unexplained", "missing", "disputed", "skipped"]
		return (names + tally.keys.filter { !names.contains($0) }.sorted()).compactMap { key in
			guard let count = tally[key], count > 0 else { return nil }
			let name =
				switch key {
				case "pass": count == 1 ? "passed case" : "passed cases"
				case "unexplained": count == 1 ? "unexplained failure" : "unexplained failures"
				case "attributed": count == 1 ? "attributed failure" : "attributed failures"
				default: key
				}
			return "\(count) \(name)"
		}.joined(separator: " · ")
	}
	init(_ wire: Wire.PlannedRun) {
		ref = wire.ref
		name = wire.name
		state = RunState(wire.state)
		verdict = RunVerdict(wire.verdict)
		reason = wire.reason
		tally = wire.tally
		slots = wire.slots
		if wire.accepts.`self` == true {
			accepts = .own
		} else if let commit = wire.accepts.commit {
			accepts = .commit(commit, repo: wire.accepts.repo, environment: wire.accepts.env)
		} else {
			accepts = .other
		}
	}
}

public enum AcceptedResults: Equatable, Sendable {
	case own, commit(String, repo: String?, environment: String?), other
	public var sentence: String {
		switch self {
		case .own: "Counts only results recorded in this run; proves nothing about a build."
		case .commit(let commit, let repo, let environment):
			// A commit is told apart by its first characters, and forty of them do not fit a phone's line.
			"Accepts results for commit \(commit.prefix(12))"
				+ (repo.map { " in \($0)" } ?? "") + (environment.map { " in \($0)" } ?? "") + "."
		case .other: "This build does not know what results this run accepts."
		}
	}
}

public struct RunFill: Identifiable, Equatable, Sendable {
	public var id: Int { result }
	public let result: Int
	public let by: String
	public let method: FillMethod
	public let outcome: FilledOutcome
	public let note: String?
	init(_ wire: Wire.RunFill) {
		result = wire.result
		by = wire.by
		method = FillMethod(wire.method)
		outcome = FilledOutcome(wire.outcome)
		note = wire.note
	}
}

public struct RunSlot: Identifiable, Equatable, Sendable {
	public let id: Int
	public let caseRef: String?
	public let title: String?
	public let version: Int
	public let state: SlotState
	public let fills: [RunFill]
	public func ownFill(by person: String) -> RunFill? {
		fills.filter { $0.by == person && $0.method == .person }.max { $0.result < $1.result }
	}
	init(_ wire: Wire.RunSlot) {
		id = wire.id
		caseRef = wire.case
		title = wire.title
		version = wire.version
		state = SlotState(wire.state)
		fills = wire.fills.map(RunFill.init)
	}
}

/// A slot and the pinned case that was shown. A later report always takes this value.
public struct RunExecution: Equatable, Sendable {
	public let run: String
	public let slot: RunSlot
	public let content: CaseContent
	package init(run: String, slot: RunSlot, content: CaseContent) {
		self.run = run
		self.slot = slot
		self.content = content
	}
}

public enum RunSelection: Equatable, Sendable {
	case all, folder(String), tag(String), text(String)
}

public enum RunReportOutcome: Equatable, Sendable {
	case recorded(Int), refused(String)
}

public enum RunPlanOutcome: Equatable, Sendable {
	case planned(ref: String, slots: Int, already: Int), refused(String)
}

package struct RunPage: Sendable {
	package let runs: [PlannedRun]
	package let next: String?
}

extension ProjectClient {
	package func runs(after cursor: String? = nil) async throws -> RunPage {
		var input: [String: JSONValue] = ["in": "runs", "limit": 100]
		if let cursor { input["cursor"] = .string(cursor) }
		let wire: Wire.RunPage = try await server.read("find", in: key, .object(input))
		return RunPage(runs: wire.items.map(PlannedRun.init), next: wire.cursor)
	}

	package func run(_ ref: String) async throws -> PlannedRun {
		let rows: [Wire.PlannedRun] = try await server.read("get", in: key, ["refs": [.string(ref)]])
		guard let row = rows.first, row.ref == ref else { throw ClientError.unreadable }
		return PlannedRun(row)
	}

	package func slots(of run: String) async throws -> [RunSlot] {
		var slots: [RunSlot] = []
		var cursor: String?
		repeat {
			var input: [String: JSONValue] = ["in": "slots", "run": .string(run), "limit": 200]
			if let cursor { input["cursor"] = .string(cursor) }
			let page: Wire.SlotPage = try await server.read("find", in: key, .object(input))
			slots += page.items.map(RunSlot.init)
			cursor = page.cursor
		} while cursor != nil
		return slots
	}

	package func execution(of slot: RunSlot, in run: String) async throws -> RunExecution {
		guard let ref = slot.caseRef else {
			throw ClientError.refused(code: "not_found", message: "This slot's case is no longer available.")
		}
		let rows: [Wire.PinnedCase] = try await server.read(
			"get", in: key,
			[
				"refs": [.string(ref)], "version": .number(Double(slot.version))
			])
		guard let row = rows.first, row.ref == ref, row.version == slot.version else {
			throw ClientError.unreadable
		}
		return RunExecution(
			run: run, slot: slot,
			content: CaseContent(
				Wire.CaseBody(
					title: row.title, pre: row.pre, steps: row.steps, methods: row.methods,
					automate: row.automate, fields: row.fields
				)))
	}

	package func report(
		_ execution: RunExecution, outcome: ManualOutcome, note: String = "", failedStep: String? = nil,
		corrects: Int? = nil
	) async throws -> RunReportOutcome {
		guard let ref = execution.slot.caseRef, execution.content.methods.contains("human") else {
			return .refused("This pinned case does not admit a person's results.")
		}
		var result: [String: JSONValue] = ["test": ["case": .string(ref)], "outcome": .string(outcome.rawValue)]
		let note = note.trimmingCharacters(in: .whitespacesAndNewlines)
		if !note.isEmpty { result["note"] = .string(note) }
		if outcome == .fail, let failedStep {
			guard execution.content.steps.contains(where: { $0.id == failedStep }) else {
				return .refused("The marked step is not in this pinned case.")
			}
			result["steps"] = [["step": .string(failedStep), "outcome": "fail"]]
		}
		if let corrects { result["corrects"] = .number(Double(corrects)) }
		let reply: Wire.RunReportReply = try await server.write(
			"report", in: key,
			[
				"run": .string(execution.run), "results": [.object(result)]
			])
		if let why = reply.rejected.first?.reason ?? reply.declined.first?.reason { return .refused(why) }
		guard let saved = reply.results.first, saved > 0 else { return .refused("The result was not recorded.") }
		return .recorded(saved)
	}

	package func runFolders() async throws -> [String] {
		let reply: Wire.RunFolders = try await server.read("find", in: key, ["in": "folders"])
		return reply.items.map(\.path)
	}

	package func planRun(name: String, selection: RunSelection, commit: String = "") async throws -> RunPlanOutcome
	{
		let select: JSONValue =
			switch selection {
			case .all: [:]
			case .folder(let path): ["folders": [.string(path)]]
			case .tag(let tag): ["tags": [.string(tag.hasPrefix("#") ? String(tag.dropFirst()) : tag)]]
			case .text(let query): ["text": .string(query)]
			}
		var input: [String: JSONValue] = [
			"name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)), "select": select
		]
		let commit = commit.trimmingCharacters(in: .whitespacesAndNewlines)
		if !commit.isEmpty { input["accepts"] = ["commit": .string(commit)] }
		do {
			let reply: Wire.RunPlanReply = try await server.write("plan", in: key, .object(input))
			return .planned(ref: reply.run, slots: reply.slots, already: reply.already)
		} catch let error as ClientError {
			if case .refused = error { return .refused(error.message) }
			throw error
		}
	}
}
