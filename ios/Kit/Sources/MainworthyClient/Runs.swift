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

/// What a run is: one somebody planned, or the one Mainworthy makes for each reported commit.
public enum RunKind: Equatable, Sendable {
	/// Planned by hand, with the number of its pinned cases when the server said.
	case planned(slots: Int?)
	/// A reported commit's run, and the change the commit belongs to, if it belongs to one.
	case change(RunChange?)
}

/// The change a change run's commit belongs to.
public struct RunChange: Equatable, Sendable {
	public let key: String
	public let title: String?
}

public struct Run: Identifiable, Equatable, Sendable {
	public let location: ResultLocation?
	public var id: String { ref }
	public let ref: String
	public let name: String
	public let kind: RunKind
	public let state: RunState
	public let verdict: RunVerdict
	public let reason: String
	public let tally: [String: Int]
	public let inProgress: Int
	public let workUntil: Date?
	public let accepts: AcceptedResults
	public let createdAt: Date
	public var isPlanned: Bool { if case .planned = kind { true } else { false } }
	/// Missing jobs are part of the tally too. Only the slot counts say how many cases remain.
	public var left: Int? {
		guard case .planned(let slots?) = kind else { return nil }
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
	init(_ wire: Wire.Run) {
		location = wire.location.map(ResultLocation.init)
		ref = wire.ref
		name = wire.name
		state = RunState(wire.state)
		verdict = RunVerdict(wire.verdict)
		reason = wire.reason
		tally = wire.tally
		inProgress = wire.inProgress
		workUntil = wire.workUntil.map { Date(timeIntervalSince1970: Double($0) / 1000) }
		createdAt = Date(timeIntervalSince1970: Double(wire.createdAt) / 1000)
		kind =
			wire.origin == "change"
			? .change(wire.change.map { RunChange(key: $0.key, title: $0.title) }) : .planned(slots: wire.slots)
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
	public let model: String?
	public let method: FillMethod
	public let outcome: FilledOutcome
	public let note: String?
	public let atStep: String?
	public let steps: [ResultStep]?
	init(_ wire: Wire.RunFill) {
		result = wire.result
		by = wire.by
		model = wire.model
		method = FillMethod(wire.method)
		outcome = FilledOutcome(wire.outcome)
		note = wire.note
		atStep = wire.atStep
		steps = wire.steps?.map(ResultStep.init)
	}
}

public enum SlotWork: Equatable, Sendable {
 case free
 case held(actor: String, since: Date, until: Date)
 public func holder(at now: Date = .now) -> (actor: String, since: Date)? {
  if case .held(let actor, let since, let until) = self, until > now { return (actor, since) }
  return nil
 }
 init(_ wire: Wire.SlotWork) {
  if wire.kind == "held", let actor = wire.actor, let since = wire.since, let until = wire.until {
   self = .held(actor: actor, since: Date(timeIntervalSince1970: Double(since) / 1000), until: Date(timeIntervalSince1970: Double(until) / 1000))
  } else { self = .free }
 }
}

public struct RunSlot: Identifiable, Equatable, Sendable {
	public let id: Int
	public let caseRef: String?
	public let title: String?
	public let version: Int
	public let state: SlotState
	public let fills: [RunFill]
	public let work: SlotWork
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
		work = SlotWork(wire.work)
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

public enum RunSelection: Hashable, Sendable {
	case all, folder(String), tag(String), text(String)

	package var select: JSONValue {
		switch self {
		case .all: [:]
		case .folder(let path): ["folders": [.string(path)]]
		case .tag(let tag): ["tags": [.string(tag.hasPrefix("#") ? String(tag.dropFirst()) : tag)]]
		case .text(let query): ["text": .string(query)]
		}
	}
}

/// A plan's choices and command, captured before the first request and kept through uncertain replies.
public struct RunPlanSubmission: Sendable {
	public let name: String
	public let selection: RunSelection
	public let commit: String
	package let command = UUID().uuidString.lowercased()
	package let delivery = WriteDelivery()
	package let input: JSONValue

	package init(name: String, selection: RunSelection, commit: String = "") {
		self.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
		self.selection = selection
		self.commit = commit.trimmingCharacters(in: .whitespacesAndNewlines)
		var input: [String: JSONValue] = ["name": .string(self.name), "select": selection.select]
		if !self.commit.isEmpty { input["accepts"] = ["commit": .string(self.commit)] }
		self.input = .object(input)
	}
}

/// A report's identity and evidence are fixed before its first send, including an Undo correction.
public struct RunReportSubmission: Sendable {
	public let execution: RunExecution
	public let outcome: ManualOutcome
	public let note: String
	public let failedStep: String?
	public let corrects: Int?
	package let steps: [ResultStep]?
	package let input: JSONValue
	package let command = UUID().uuidString.lowercased()
	package let delivery = WriteDelivery()

	package init(execution: RunExecution, outcome: ManualOutcome, note: String, failedStep: String?,
		corrects: Int?, steps: [ResultStep]?, input: JSONValue) {
		self.execution = execution
		self.outcome = outcome
		self.note = note
		self.failedStep = failedStep
		self.corrects = corrects
		self.steps = steps
		self.input = input
	}
}

public enum RunReportOutcome: Equatable, Sendable {
	case recorded(Int), refused(String), resendRefused(String)
}

public enum RunPlanOutcome: Equatable, Sendable {
	case planned(ref: String, slots: Int, already: Int), refused(String)
}

package struct RunPage: Sendable {
	package let runs: [Run]
	package let next: String?
}

/// Which runs a list shows. Nothing chosen is every one of them.
public struct RunFilter: Equatable, Sendable {
	public enum Kind: String, CaseIterable, Sendable { case planned, change }
	public enum State: String, CaseIterable, Sendable { case open, closed }
	public var kind: Kind?
	public var state: State?
	/// A change key: only the runs of that change's commits.
	public var change: String?
	public init(kind: Kind? = nil, state: State? = nil, change: String? = nil) {
		self.kind = kind
		self.state = state
		self.change = change
	}
	/// Whether the list this filter chooses holds the run.
	public func admits(_ run: Run) -> Bool {
		let kindHolds =
			switch (kind, run.kind) {
			case (nil, _), (.planned, .planned), (.change, .change): true
			default: false
			}
		let changeHolds =
			switch run.kind {
			case .change(let header): change == nil || header?.key == change
			case .planned: change == nil
			}
		return kindHolds && changeHolds && (state == nil || state?.rawValue == run.state.word)
	}
}

extension ProjectClient {
	package func runs(_ filter: RunFilter = RunFilter(), after cursor: String? = nil, limit: Int = 100) async throws
		-> RunPage
	{
		var input: [String: JSONValue] = ["in": "runs", "limit": .number(Double(limit))]
		if let kind = filter.kind { input["origin"] = .string(kind.rawValue) }
		if let state = filter.state { input["state"] = .string(state.rawValue) }
		if let change = filter.change { input["change"] = .string(change) }
		if let cursor { input["cursor"] = .string(cursor) }
		let wire: Wire.RunPage = try await server.read("find", in: key, .object(input))
		return RunPage(runs: wire.items.map(Run.init), next: wire.cursor)
	}

	package func run(_ ref: String) async throws -> Run {
		let rows: [Wire.Run] = try await server.read("get", in: key, ["refs": [.string(ref)]])
		guard let row = rows.first, row.ref == ref else { throw ClientError.unreadable }
		return Run(row)
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
					// A case that is read alone leaves its custom fields out. A run shows none of them.
					automate: row.automate, fields: row.fields ?? [:]
				)))
	}

	package func prepareReport(
		_ execution: RunExecution, outcome: ManualOutcome, note: String = "", failedStep: String? = nil,
		corrects: Int? = nil, steps: [ResultStep]? = nil, restoring: Int? = nil
	) async throws -> RunReportSubmission {
		guard let ref = execution.slot.caseRef, execution.content.methods.contains("human") else {
			throw ClientError.refused(code: "invalid", message: "This pinned case does not admit a person's results.")
		}
		var result: [String: JSONValue] = ["test": ["case": .string(ref)], "outcome": .string(outcome.rawValue)]
		let text = restoring == nil ? note.trimmingCharacters(in: .whitespacesAndNewlines) : note
		if !text.isEmpty { result["note"] = .string(text) }
		if let steps {
			result["steps"] = .array(steps.map(\.json))
		} else if outcome == .fail, let failedStep {
			guard execution.content.steps.contains(where: { $0.id == failedStep }) else {
				throw ClientError.refused(code: "invalid", message: "The marked step is not in this pinned case.")
			}
			result["steps"] = [["step": .string(failedStep), "outcome": "fail"]]
		}
		if let corrects { result["corrects"] = .number(Double(corrects)) }
		if let restoring { result["attachments"] = .array(try await reportAttachments(result: restoring)) }
		return RunReportSubmission(execution: execution, outcome: outcome, note: note,
			failedStep: failedStep, corrects: corrects, steps: steps,
			input: ["run": .string(execution.run), "results": [.object(result)]])
	}

	package func report(_ submission: RunReportSubmission, recovering: Bool = false) async throws -> RunReportOutcome {
		let delivery = recovering ? WriteDelivery() : submission.delivery
		do {
			let reply: Wire.RunReportReply
			if recovering {
				let command: Wire.RunReportCommand = try await server.read("command", in: key,
					["cmd": .string(submission.command)])
				switch command.state {
				case "done":
					guard let recorded = command.reply else { throw ClientError.unreadable }
					reply = recorded
				case "none":
					reply = try await server.write("report", in: key, submission.input,
						command: submission.command, delivery: delivery)
				case "begun":
					throw ClientError.unreachable("The report is still being recorded. Retry to ask again.")
				default: throw ClientError.unreadable
				}
			} else {
				reply = try await server.write("report", in: key, submission.input,
					command: submission.command, delivery: delivery)
			}
			if let why = reply.rejected.first?.reason ?? reply.declined.first?.reason { return .refused(why) }
			guard let saved = reply.results.first, saved > 0 else { return .refused("The result was not recorded.") }
			return .recorded(saved)
		} catch {
			if case ClientError.refused(let code, _) = error, code != "internal",
				delivery.definitelyRejected {
				return recovering ? .resendRefused(error.shown) : .refused(error.shown)
			}
			submission.delivery.uncertain()
			throw error
		}
	}

	package func runFolders() async throws -> [String] {
		let reply: Wire.RunFolders = try await server.read("find", in: key, ["in": "folders"])
		return reply.items.map(\.path)
	}

	package func countRunCases(_ selection: RunSelection) async throws -> Int {
		let reply: Wire.RunCaseCount = try await server.read("find", in: key,
			["in": "cases", "select": selection.select, "limit": 1])
		return reply.count
	}

	package func planRun(_ submission: RunPlanSubmission, recovering: Bool = false) async throws -> RunPlanOutcome {
		do {
			let reply: Wire.RunPlanReply
			if recovering {
				let command: Wire.RunPlanCommand = try await server.read("command", in: key,
					["cmd": .string(submission.command)])
				switch command.state {
				case "done":
					guard let recorded = command.reply else { throw ClientError.unreadable }
					reply = recorded
				case "none":
					reply = try await server.write("plan", in: key, submission.input,
						command: submission.command, delivery: submission.delivery)
				case "begun":
					throw ClientError.unreachable("The plan is still being recorded. Retry to ask again.")
				default: throw ClientError.unreadable
				}
			} else {
				reply = try await server.write("plan", in: key, submission.input,
					command: submission.command, delivery: submission.delivery)
			}
			return .planned(ref: reply.run, slots: reply.slots, already: reply.already)
		} catch {
			if case ClientError.refused(let code, _) = error, code != "internal",
				submission.delivery.definitelyRejected { return .refused(error.shown) }
			submission.delivery.uncertain()
			throw error
		}
	}
}
