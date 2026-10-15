import CryptoKit
import Foundation
import MainworthyClient
import Observation

/// Answers saved before sending, and the server's reply to each. One person, instance and project own a file.
@MainActor @Observable
public final class AnswerOutbox {
	public struct Entry: Codable, Identifiable, Equatable, Sendable {
		fileprivate enum Delivery: String, Codable, Sendable { case unsent, rejected, uncertain, dropped }
		package let answer: PreparedAnswer
		fileprivate var delivery: Delivery?
		public var id: String { answer.command }
		public var question: String { answer.question }
		public var title: String { answer.title }
		public var label: String { answer.label }
		public fileprivate(set) var outcome: AnswerOutcome?
		public fileprivate(set) var problem: String?
		public var waiting: Bool { outcome == nil && delivery != .dropped }
		public var dropped: Bool { outcome == nil && delivery == .dropped }

		public var status: String {
			switch outcome {
			case nil: dropped ? "Dropped" : "Waiting to send"
			case .decided: "Recorded"
			case .advised: "Recorded as advice"
			case .overtaken: "Overtaken"
			case .notTaken: "Refused"
			}
		}

		public var detail: String {
			switch outcome {
			case nil: dropped
				? "This answer is never sent again and does not hold up later answers. Each send pass checks for an outcome. This entry stays until a recorded outcome can be cleared."
				: problem ?? "Saved on this device. Sends when the app can reach the server."
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
	public var pendingCount: Int { entries.filter(\.waiting).count }
	public var hasDropped: Bool { entries.contains(where: \.dropped) }
	public var stuck: Entry? {
		guard let first = entries.first(where: \.waiting), first.problem != nil else { return nil }
		return first
	}
	private let project: ProjectClient
	private let store: any AnswerStore
	private var readable = true
	private var active = true

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

	package func enqueue(_ answer: PreparedAnswer) throws -> String {
		guard active, readable else { throw ClientError.refused(code: "local", message: storageProblem ?? "This workspace is signed out.") }
		if let existing = entries.first(where: { $0.id == answer.command || ($0.question == answer.question && $0.waiting) }) { return existing.id }
		let entry = Entry(answer: answer, delivery: .unsent)
		try save(entries + [entry])
		entries.append(entry)
		return entry.id
	}

	/// Stops new sends when the person signs out or loses the project. A reply already in flight may still arrive.
	package func stop() { active = false }
	package func resume() { active = true }

	/// Stops replaying the head answer, retaining its command whenever an earlier send may still arrive.
	public func drop(_ id: String) async {
		guard active, readable, !sending, let entry = stuck, entry.id == id else { return }
		do {
			sending = true
			defer { sending = false }
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
			case .recorded(let outcome):
				updated[index].outcome = outcome
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
		defer { sending = false }
		for entry in entries where entry.dropped {
			guard active, !Task.isCancelled else { return }
			let command = try? await project.answerCommand(entry.answer)
			guard active, !Task.isCancelled else { return }
			if case .recorded(let outcome) = command {
				var updated = entries
				guard let index = updated.firstIndex(where: { $0.id == entry.id }) else { continue }
				updated[index].outcome = outcome
				do { try save(updated); entries = updated }
				catch { storageProblem = "The result could not be saved on this device. The dropped command was kept. \(error.shown)"; return }
			}
		}
		while active, !Task.isCancelled, let entry = entries.first(where: \.waiting) {
			var beforeSending = entries
			guard let sendingIndex = beforeSending.firstIndex(where: { $0.id == entry.id }) else { return }
			beforeSending[sendingIndex].delivery = .uncertain
			do { try save(beforeSending); entries = beforeSending }
			catch { storageProblem = "The send could not be saved on this device. No request was sent. \(error.shown)"; return }
			let delivery = WriteDelivery()
			let outcome: AnswerOutcome?
			let problem: String?
			var rejected = false
			var pause = false
			do {
				outcome = try await project.send(entry.answer, delivery: delivery)
				problem = nil
			} catch ClientError.refused(let code, let why) where code != "internal" && delivery.definitelyRejected && (entry.delivery == .unsent || entry.delivery == .rejected) {
				outcome = .notTaken(why)
				problem = nil
			} catch {
				rejected = delivery.definitelyRejected && (entry.delivery == .unsent || entry.delivery == .rejected)
				outcome = nil
				let why = error.shown
				let stop = why.last.map { ".!?".contains($0) } == true ? "" : "."
				problem = "\(why)\(stop) The saved answer is waiting to send."
				pause = true
			}
			// A stopped workspace must not overwrite a new workspace using the same saved file.
			guard active else { return }
			// Another answer can be saved while this request waits. Preserve it and any cleared outcomes.
			var updated = entries
			guard let index = updated.firstIndex(where: { $0.id == entry.id }) else { return }
			updated[index].outcome = outcome
			updated[index].problem = problem
			updated[index].delivery = rejected ? .rejected : .uncertain
			do {
				try save(updated)
				entries = updated
			} catch {
				storageProblem = "The result could not be saved on this device. Retry sends the same command. \(error.shown)"
				return
			}
			if pause { return }
		}
	}

	public func clearOutcomes() {
		guard readable else { return }
		let waiting = entries.filter { $0.outcome == nil }
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
