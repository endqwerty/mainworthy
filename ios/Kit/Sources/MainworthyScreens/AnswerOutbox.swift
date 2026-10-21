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
		fileprivate enum Delivery: String, Codable, Sendable { case unsent, rejected, uncertain, dropped, obsolete }
		package let answer: PreparedAnswer
		fileprivate var delivery: Delivery?
		public fileprivate(set) var droppedAt: Date?
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
		/// Whether this answer has an outcome or belongs to an obsolete project.
		public var finished: Bool { outcomes != nil || obsolete }
		public var obsolete: Bool { outcomes == nil && delivery == .obsolete }
		/// What became of an answer to one question, for tests. A screen asks `finished`, or each member: this is
		/// nil for an answer to several questions, finished or not (the verifier's finding of 2026-10-16).
		package var outcome: AnswerOutcome? { answer.members.count == 1 ? outcomes?[question] : nil }
		public var waiting: Bool { !finished && delivery != .dropped }
		public var dropped: Bool { outcomes == nil && delivery == .dropped }
		fileprivate var forgetAt: Date? { dropped ? droppedAt?.addingTimeInterval(24 * 60 * 60) : nil }

		fileprivate init(answer: PreparedAnswer, delivery: Delivery) {
			self.answer = answer
			self.delivery = delivery
		}

		private enum Keys: String, CodingKey {
			case answer, delivery, outcomes, problem, droppedAt
			/// An entry an earlier build saved: the outcome of its one question.
			case outcome
		}

		public init(from decoder: any Decoder) throws {
			let container = try decoder.container(keyedBy: Keys.self)
			answer = try container.decode(PreparedAnswer.self, forKey: .answer)
			delivery = try container.decodeIfPresent(Delivery.self, forKey: .delivery)
			problem = try container.decodeIfPresent(String.self, forKey: .problem)
			droppedAt = try container.decodeIfPresent(Date.self, forKey: .droppedAt)
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
			try container.encodeIfPresent(droppedAt, forKey: .droppedAt)
		}

		public var status: String {
			if obsolete { return "Obsolete" }
			guard let outcomes else { return dropped ? "Dropped" : "Waiting to send" }
			if answer.members.count == 1, let outcome = outcomes[question] { return Entry.status(of: outcome) }
			let decided = outcomes.values.filter(\.isDecided).count
			return decided == outcomes.count ? "Recorded" : "Recorded \(decided) of \(outcomes.count)"
		}

		public var detail: String {
			if obsolete { return "This answer belongs to an earlier project or has no project identity. Its outcome is unknown. This app will not send it again. Read the current project before answering again." }
			guard let outcomes else {
				let all = answer.members.count == 1 ? "" : " All \(answer.members.count) answers go together."
				return dropped
					? "This answer is never sent again and does not hold up later answers. Each send pass checks for an outcome. If the server records it, its outcome appears here. After 24 hours you can forget this entry with confirmation.\(all)"
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
	private let now: () -> Date
	private var readable = true
	private var active = true
	private var sendWaiters: [String: [CheckedContinuation<Void, Never>]] = [:]

	package init(project: ProjectClient, store: any AnswerStore = MemoryAnswerStore(), now: @escaping () -> Date = Date.init) {
		self.project = project
		self.store = store
		self.now = now
		do {
			if let data = try store.load() {
				let saved = try JSONDecoder().decode([Entry].self, from: data)
				guard Set(saved.map(\.id)).count == saved.count else { throw ClientError.unreadable }
				entries = saved.map { entry in
					var entry = entry
					if entry.outcomes == nil, entry.answer.projectIdentity != project.identity {
						entry.delivery = .obsolete
						entry.problem = nil
					}
					return entry
				}
			}
			storageProblem = store.loadWarning
			var dated = entries
			for index in dated.indices where dated[index].dropped && dated[index].droppedAt == nil {
				dated[index].droppedAt = now()
			}
			if dated != entries {
				do { try save(dated); entries = dated; storageProblem = store.loadWarning }
				catch { storageProblem = "The drop time could not be saved on this device. The saved answer was kept. \(error.shown)" }
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
		guard answer.projectIdentity == project.identity else {
			throw ClientError.refused(code: "obsolete_project", message: "This answer belongs to an obsolete project.")
		}
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
	package func retire() {
		guard active else { return }
		stop()
		for index in entries.indices where entries[index].outcomes == nil { entries[index].delivery = .obsolete; entries[index].problem = nil }
		try? save(entries)
	}
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
					updated[index].droppedAt = now()
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

	/// One device-clock wait until the next Dropped entry becomes eligible. Already eligible entries need no timer.
	public var nextForgetDelay: TimeInterval? {
		let current = now()
		return entries.compactMap(\.forgetAt).map { $0.timeIntervalSince(current) }.filter { $0 > 0 }.min()
	}

	/// Device-clock eligibility only. Forget always requires the person's confirmation.
	public func canForget(_ id: String) -> Bool {
		guard let at = entries.first(where: { $0.id == id })?.forgetAt else { return false }
		return now() >= at
	}

	private static let forgetWhileSending =
		"Saved answers were being sent, so this answer was kept. If Forget is still offered, try it again."

	public func forget(_ id: String, confirmed: Bool = false) {
		guard confirmed, active, readable else { return }
		guard !sending else {
			dropProblem = Self.forgetWhileSending
			return
		}
		// Forget takes back only what it said; a drop's sentence about another answer stays.
		if dropProblem == Self.forgetWhileSending { dropProblem = nil }
		guard canForget(id) else { return }
		let kept = entries.filter { $0.id != id }
		do { try save(kept); entries = kept }
		catch { storageProblem = "The saved answer could not be forgotten on this device. It was kept. \(error.shown)" }
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
			} catch ClientError.refused(let code, _) where code == "obsolete_project" {
				guard active else { return false }
				var updated = entries
				if let index = updated.firstIndex(where: { $0.id == entry.id }) {
					updated[index].delivery = .obsolete
					updated[index].problem = nil
					do { try save(updated); entries = updated }
					catch { storageProblem = error.shown; return false }
				}
				finishWaiting(for: entry.id)
				continue
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
		guard active, readable else { return }
		let waiting = entries.filter { !$0.finished }
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
	var loadWarning: String? { get }
	func load() throws -> Data?
	func save(_ data: Data) throws
}

extension AnswerStore {
	package var loadWarning: String? { nil }
}

@MainActor
package final class MemoryAnswerStore: AnswerStore {
	var data: Data?
	package init() {}
	package func load() throws -> Data? { data }
	package func save(_ data: Data) throws { self.data = data }
}

@MainActor
package final class FileAnswerStore: AnswerStore {
	let file: URL
	private let legacy: URL
	private let prefix: String
	private var imported: [URL] = []
	package private(set) var loadWarning: String?

	package init(instance: Instance, person: Int, project: String, identity: String, directory: URL? = nil) {
		let root = directory ?? URL.applicationSupportDirectory.appending(path: "Mainworthy/Answers", directoryHint: .isDirectory)
		let scope = [instance.url.absoluteString, String(person), project]
		let name = SHA256.hash(data: try! JSONEncoder().encode(scope)).map { String(format: "%02x", $0) }.joined()
		legacy = root.appendingPathComponent(name + ".json")
		prefix = name + "."
		let incarnation = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
		file = root.appendingPathComponent(prefix + incarnation + ".json")
	}

	package func load() throws -> Data? {
		loadWarning = nil
		let root = file.deletingLastPathComponent()
		let current: Data?
		if FileManager.default.fileExists(atPath: file.path) {
			try excludeFromBackup(root)
			try excludeFromBackup(file)
			let data = try Data(contentsOf: file)
			let saved = try JSONDecoder().decode([AnswerOutbox.Entry].self, from: data)
			guard Set(saved.map(\.id)).count == saved.count else { throw ClientError.unreadable }
			current = data
		} else { current = nil }
		guard FileManager.default.fileExists(atPath: root.path) else { return nil }
		let older = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
			.filter {
				let name = $0.lastPathComponent
				return name != file.lastPathComponent
					&& (name == legacy.lastPathComponent || (name.hasPrefix(prefix) && $0.pathExtension == "json"))
			}
		guard !older.isEmpty else { return current }
		var seen = Set<String>()
		var entries: [AnswerOutbox.Entry] = []
		for url in older.sorted(by: { $0.path < $1.path }) {
			do {
				try excludeFromBackup(root)
				try excludeFromBackup(url)
				let saved = try JSONDecoder().decode([AnswerOutbox.Entry].self, from: Data(contentsOf: url))
				if current != nil {
					try FileManager.default.removeItem(at: url)
				} else {
					for entry in saved where seen.insert(entry.id).inserted { entries.append(entry) }
					imported.append(url)
				}
			} catch {
				if current == nil {
					loadWarning = "Some earlier saved answers could not be read and were skipped. You can still save answers for this project."
				}
			}
		}
		return try current ?? JSONEncoder().encode(entries)
	}

	package func save(_ data: Data) throws {
		try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
		try excludeFromBackup(file.deletingLastPathComponent())
		try data.write(to: file, options: .atomic)
		try excludeFromBackup(file)
		for url in imported where FileManager.default.fileExists(atPath: url.path) {
			try FileManager.default.removeItem(at: url)
		}
		imported = []
	}

	private func excludeFromBackup(_ url: URL) throws {
		var url = url
		var values = URLResourceValues()
		values.isExcludedFromBackup = true
		try url.setResourceValues(values)
	}
}
