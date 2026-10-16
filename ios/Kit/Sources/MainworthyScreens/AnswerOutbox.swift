import CryptoKit
import Foundation
import MainworthyClient
import Observation

/// Answers saved before sending, and the server's reply to each. One person, instance and project own a file.
///
/// A saved answer is one command: an answer to one question, or one answer to several (decision 0088). It is
/// sent whole, recovered whole and dropped whole, and the server's reply says what became of each question.
@MainActor @Observable
public final class AnswerOutbox {
	/// One question of a saved answer, and what became of it once the server replied.
	public struct SavedQuestion: Equatable, Sendable {
		public let question: String
		public let title: String
		public let outcome: AnswerOutcome?
	}

	public struct Entry: Codable, Identifiable, Equatable, Sendable {
		fileprivate enum Delivery: String, Codable, Sendable { case unsent, rejected, uncertain, dropped }
		package let answer: PreparedAnswer
		fileprivate var delivery: Delivery?
		/// What became of each question, once the server's reply to the whole command was read.
		public fileprivate(set) var outcomes: [String: AnswerOutcome]?
		public fileprivate(set) var problem: String?
		public var id: String { answer.command }
		/// The questions it answers, in the order they were sent.
		public var questions: [String] { answer.members.map(\.question) }
		/// The first question it answers: the only one of an answer to one question.
		public var question: String { answer.members[0].question }
		public var title: String {
			answer.members.count == 1 ? answer.members[0].title : "\(answer.members.count) questions"
		}
		public var label: String { answer.label }
		public var members: [SavedQuestion] {
			answer.members.map { SavedQuestion(question: $0.question, title: $0.title, outcome: outcomes?[$0.question]) }
		}
		/// Whether the server's reply to the whole command was read: each question has its outcome.
		public var finished: Bool { outcomes != nil }
		/// What became of an answer to one question, for tests. A screen asks `finished`, or each member: this is
		/// nil for an answer to several questions, finished or not (the verifier's finding of 2026-10-16).
		package var outcome: AnswerOutcome? { answer.members.count == 1 ? outcomes?[question] : nil }
		public var waiting: Bool { outcomes == nil && delivery != .dropped }
		public var dropped: Bool { outcomes == nil && delivery == .dropped }

		fileprivate init(answer: PreparedAnswer, delivery: Delivery) {
			self.answer = answer
			self.delivery = delivery
		}

		private enum Keys: String, CodingKey {
			case answer, delivery, outcomes, problem
			/// An entry an earlier build saved: the outcome of its one question.
			case outcome
		}

		public init(from decoder: any Decoder) throws {
			let container = try decoder.container(keyedBy: Keys.self)
			answer = try container.decode(PreparedAnswer.self, forKey: .answer)
			delivery = try container.decodeIfPresent(Delivery.self, forKey: .delivery)
			problem = try container.decodeIfPresent(String.self, forKey: .problem)
			if let outcomes = try container.decodeIfPresent([String: AnswerOutcome].self, forKey: .outcomes) {
				self.outcomes = outcomes
			} else if let outcome = try container.decodeIfPresent(AnswerOutcome.self, forKey: .outcome) {
				outcomes = [answer.members[0].question: outcome]
			}
			if let outcomes, Set(outcomes.keys) != Set(answer.members.map(\.question)) { throw ClientError.unreadable }
		}

		public func encode(to encoder: any Encoder) throws {
			var container = encoder.container(keyedBy: Keys.self)
			try container.encode(answer, forKey: .answer)
			try container.encodeIfPresent(delivery, forKey: .delivery)
			try container.encodeIfPresent(outcomes, forKey: .outcomes)
			try container.encodeIfPresent(problem, forKey: .problem)
		}

		public var status: String {
			guard let outcomes else { return dropped ? "Dropped" : "Waiting to send" }
			if answer.members.count == 1, let outcome = outcomes[question] { return Entry.status(of: outcome) }
			let decided = outcomes.values.filter(\.isDecided).count
			return decided == outcomes.count ? "Recorded" : "Recorded \(decided) of \(outcomes.count)"
		}

		public var detail: String {
			guard let outcomes else {
				let all = answer.members.count == 1 ? "" : " All \(answer.members.count) answers go together."
				return dropped
					? "This answer is never sent again and does not hold up later answers. Each send pass checks for an outcome. If the server records it, its outcome appears here. If it never does, this entry stays.\(all)"
					: (problem ?? "Saved on this device. Sends when the app can reach the server.") + all
			}
			if answer.members.count == 1, let outcome = outcomes[question] { return Entry.detail(of: outcome) }
			let others = members.compactMap { member -> String? in
				guard let outcome = member.outcome, !outcome.isDecided else { return nil }
				return "\(member.question): \(Entry.status(of: outcome)). \(Entry.detail(of: outcome))"
			}
			return others.isEmpty ? "The server recorded every answer." : others.joined(separator: " ")
		}

		public static func status(of outcome: AnswerOutcome) -> String {
			switch outcome {
			case .decided: "Recorded"
			case .advised: "Recorded as advice"
			case .overtaken: "Overtaken"
			case .notTaken: "Refused"
			}
		}

		static func detail(of outcome: AnswerOutcome) -> String {
			switch outcome {
			case .decided: "The server recorded this answer."
			case .advised(let who): "Waiting for \(who)."
			case .overtaken(let why): "\(why). Read the question again and choose an answer on its current evidence. This saved answer will not be sent again."
			case .notTaken(let why): "\(why). Read the question again before giving another answer."
			}
		}
	}

	public private(set) var entries: [Entry] = []
	public private(set) var sending = false
	public private(set) var storageProblem: String?
	public private(set) var dropProblem: String?
	/// How many questions have an answer waiting to send.
	public var pendingCount: Int { entries.filter(\.waiting).reduce(0) { $0 + $1.answer.members.count } }
	public var hasDropped: Bool { entries.contains(where: \.dropped) }
	public var stuck: Entry? {
		guard let first = entries.first(where: \.waiting), first.problem != nil else { return nil }
		return first
	}
	private let project: ProjectClient
	private let store: any AnswerStore
	private var readable = true
	private var active = true
	private var sendWaiters: [String: [CheckedContinuation<Void, Never>]] = [:]

	package init(project: ProjectClient, store: any AnswerStore = MemoryAnswerStore()) {
		self.project = project
		self.store = store
		do {
			if let data = try store.load() {
				let saved = try JSONDecoder().decode([Entry].self, from: data)
				guard Set(saved.map(\.id)).count == saved.count else { throw ClientError.unreadable }
				entries = saved
			}
		} catch {
			readable = false
			storageProblem = "Saved answers could not be read. They have not been replaced. \(error.shown)"
		}
	}

	/// Saves one answer to these questions, as they were shown, and sends it: one command. Returns the saved answer
	/// once its attempt has an outcome, or once the queue paused before it (it is then still waiting). Nothing is
	/// sent when it cannot be saved.
	package func record(
		_ questions: [Question], with choice: Choice, reference: String = "", reason: String = ""
	) async throws -> Entry {
		guard let answer = project.prepareAnswer(questions, with: choice, reference: reference, reason: reason) else {
			throw ClientError.refused(code: "local", message: "This answer needs the web app.")
		}
		let id = try enqueue(answer)
		await send(id)
		return entries.first { $0.id == id } ?? Entry(answer: answer, delivery: .uncertain)
	}

	/// Saves an answer to send. It is taken whole or not at all: a question with an answer still waiting to send is
	/// not answered again, and the same command saved twice is saved once.
	package func enqueue(_ answer: PreparedAnswer) throws -> String {
		guard active, readable else { throw ClientError.refused(code: "local", message: storageProblem ?? "This workspace is signed out.") }
		if let existing = entries.first(where: { $0.id == answer.command }) { return existing.id }
		let asked = Set(answer.members.map(\.question))
		if let waiting = entries.first(where: { $0.waiting && !asked.isDisjoint(with: $0.questions) }) {
			let ref = waiting.questions.first(where: asked.contains) ?? waiting.question
			throw ClientError.refused(code: "local", message: "\(ref) has an answer waiting to send.")
		}
		let entry = Entry(answer: answer, delivery: .unsent)
		try save(entries + [entry])
		entries.append(entry)
		return entry.id
	}

	/// Stops new sends when the person signs out or loses the project. A reply already in flight may still arrive.
	package func stop() { active = false; finishWaiting() }
	package func resume() { active = true }

	/// Stops replaying the head answer, retaining its command whenever an earlier send may still arrive.
	public func drop(_ id: String) async {
		guard active, readable, !sending, let entry = stuck, entry.id == id else { return }
		do {
			sending = true
			defer { sending = false; finishWaiting() }
			dropProblem = nil
			let command: AnswerCommand
			do { command = try await project.answerCommand(entry.answer) }
			catch {
				guard active else { return }
				dropProblem = "The command could not be checked. The saved answer was kept. \(error.shown)"
				return
			}
			guard active, !Task.isCancelled else { return }
			var updated = entries
			guard let index = updated.firstIndex(where: { $0.id == id }) else { return }
			switch command {
			case .notRecorded:
				if entry.delivery == .rejected || entry.delivery == .unsent { updated.remove(at: index) }
				else {
					updated[index].delivery = .dropped
					updated[index].problem = nil
				}
			case .recorded(let outcomes):
				updated[index].outcomes = outcomes
				updated[index].problem = nil
			case .recording:
				dropProblem = "The server is still recording this answer. It was kept. Keep trying resends the same answer and command id."
				return
			}
			do {
				try save(updated)
				entries = updated
			} catch {
				storageProblem = "The saved answer could not be updated on this device. It was kept. \(error.shown)"
				return
			}
		}
		await send()
	}

	/// Sends in saved order. An uncertain reply pauses the queue; its original command is safe to retry.
	public func send() async {
		guard active, readable, !sending else { return }
		dropProblem = nil
		sending = true
		defer { sending = false; finishWaiting() }
		guard await sendWaitingAnswers() else { return }
		for entry in entries where entry.dropped {
			guard active, !Task.isCancelled else { return }
			let command: AnswerCommand
			do { command = try await project.answerCommand(entry.answer) }
			catch { break }
			guard active, !Task.isCancelled else { return }
			if case .recorded(let outcomes) = command {
				var updated = entries
				guard let index = updated.firstIndex(where: { $0.id == entry.id }) else { continue }
				updated[index].outcomes = outcomes
				do { try save(updated); entries = updated }
				catch { storageProblem = "The result could not be saved on this device. The dropped command was kept. \(error.shown)"; return }
			}
		}
		// Answers saved during the dropped checks still belong to this pass. A failed send pauses it.
		_ = await sendWaitingAnswers()
	}

	/// Waits for this answer's attempt, without holding its screen open for dropped-command checks.
	package func send(_ id: String) async {
		guard active, readable, entries.contains(where: { $0.id == id && $0.waiting }) else { return }
		await withCheckedContinuation { continuation in
			sendWaiters[id, default: []].append(continuation)
			if !sending { Task { await send() } }
		}
	}

	private func finishWaiting(for id: String? = nil) {
		let waiters: [CheckedContinuation<Void, Never>]
		if let id { waiters = sendWaiters.removeValue(forKey: id) ?? [] }
		else { waiters = sendWaiters.values.flatMap { $0 }; sendWaiters.removeAll() }
		for waiter in waiters { waiter.resume() }
	}

	private func sendWaitingAnswers() async -> Bool {
		while active, !Task.isCancelled, let entry = entries.first(where: \.waiting) {
			var beforeSending = entries
			guard let sendingIndex = beforeSending.firstIndex(where: { $0.id == entry.id }) else { return false }
			beforeSending[sendingIndex].delivery = .uncertain
			do { try save(beforeSending); entries = beforeSending }
			catch { storageProblem = "The send could not be saved on this device. No request was sent. \(error.shown)"; return false }
			let delivery = WriteDelivery()
			let outcomes: [String: AnswerOutcome]?
			let problem: String?
			var rejected = false
			var pause = false
			do {
				outcomes = try await project.send(entry.answer, delivery: delivery)
				problem = nil
			} catch ClientError.refused(let code, let why) where code != "internal" && delivery.definitelyRejected && (entry.delivery == .unsent || entry.delivery == .rejected) {
				// The whole request was refused: no question of it was answered.
				outcomes = Dictionary(uniqueKeysWithValues: entry.questions.map { ($0, AnswerOutcome.notTaken(why)) })
				problem = nil
			} catch {
				rejected = delivery.definitelyRejected && (entry.delivery == .unsent || entry.delivery == .rejected)
				outcomes = nil
				let why = error.shown
				let stop = why.last.map { ".!?".contains($0) } == true ? "" : "."
				problem = "\(why)\(stop) The saved answer is waiting to send."
				pause = true
			}
			// A stopped workspace must not overwrite a new workspace using the same saved file.
			guard active else { return false }
			// Another answer can be saved while this request waits. Preserve it and any cleared outcomes.
			var updated = entries
			guard let index = updated.firstIndex(where: { $0.id == entry.id }) else { return false }
			updated[index].outcomes = outcomes
			updated[index].problem = problem
			updated[index].delivery = rejected ? .rejected : .uncertain
			do {
				try save(updated)
				entries = updated
			} catch {
				storageProblem = "The result could not be saved on this device. Retry sends the same command. \(error.shown)"
				return false
			}
			finishWaiting(for: entry.id)
			if pause { return false }
		}
		return active && !Task.isCancelled
	}

	public func clearOutcomes() {
		guard readable else { return }
		let waiting = entries.filter { $0.outcomes == nil }
		do {
			try save(waiting)
			entries = waiting
		} catch { storageProblem = error.shown }
	}

	private func save(_ entries: [Entry]) throws {
		try store.save(JSONEncoder().encode(entries))
		storageProblem = nil
	}
}

@MainActor
package protocol AnswerStore {
	func load() throws -> Data?
	func save(_ data: Data) throws
}

@MainActor
package final class MemoryAnswerStore: AnswerStore {
	var data: Data?
	package init() {}
	package func load() throws -> Data? { data }
	package func save(_ data: Data) throws { self.data = data }
}

@MainActor
package struct FileAnswerStore: AnswerStore {
	let file: URL

	package init(instance: Instance, person: Int, project: String, directory: URL? = nil) {
		let root = directory ?? URL.applicationSupportDirectory.appending(path: "Mainworthy/Answers", directoryHint: .isDirectory)
		let scope = [instance.url.absoluteString, String(person), project]
		let name = SHA256.hash(data: try! JSONEncoder().encode(scope)).map { String(format: "%02x", $0) }.joined()
		file = root.appendingPathComponent(name + ".json")
	}

	package func load() throws -> Data? {
		guard FileManager.default.fileExists(atPath: file.path) else { return nil }
		try excludeFromBackup(file.deletingLastPathComponent())
		try excludeFromBackup(file)
		return try Data(contentsOf: file)
	}

	package func save(_ data: Data) throws {
		try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
		try excludeFromBackup(file.deletingLastPathComponent())
		try data.write(to: file, options: .atomic)
		try excludeFromBackup(file)
	}

	private func excludeFromBackup(_ url: URL) throws {
		var url = url
		var values = URLResourceValues()
		values.isExcludedFromBackup = true
		try url.setResourceValues(values)
	}
}
