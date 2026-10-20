import Foundation
import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("Saved answers belong to a project identity", .enabled(if: Live.isRunning, "needs the live test server"))
@MainActor
struct ProjectIdentityTests {
	private func replace(_ key: String) async throws {
		var request = URLRequest(url: Live.instance.url.appending(path: "/test/replace-project"))
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue("Bearer \(Live.token)", forHTTPHeaderField: "Authorization")
		request.httpBody = try JSONEncoder().encode(["project": key])
		let (_, response) = try await URLSession.shared.data(for: request)
		#expect((response as? HTTPURLResponse)?.statusCode == 200)
	}

	@Test("resolving an absent project fails instead of inventing an identity")
	func absentProject() async throws {
		let server = try await Live.signedIn()
		await #expect(throws: ClientError.unreadable) {
			_ = try await server.project("absent-\(UUID().uuidString)")
		}
	}

	@Test("a resolved client can prepare an answer before its first read")
	func preparedAtConstruction() async throws {
		let server = try await Live.signedIn()
		let key = try await Live.project()
		let named = try #require(try await server.account().projects.first { $0.key == key })
		let reader = server.project(key, identity: named.id)
		let question = try #require(try await reader.questions(open: true, kind: .failure).questions.first)
		let choice = try #require(question.choices.first { $0.answer == "flaky" })
		let client = try await server.project(key)
		let answer = try #require(client.prepareAnswer(question, with: choice))
		#expect(answer.projectIdentity == named.id)
	}

	@Test("replacing a project after an account read refuses an answer paused before delivery")
	func pausedSend() async throws {
		let transport = SwitchableQueueTransport()
		let server = try await Live.signedIn(transport: transport)
		let key = try await Live.project()
		let account = try await server.account()
		let identity = try #require(account.projects.first { $0.key == key }).id
		let project = server.project(key, identity: identity)
		let question = try #require(try await project.questions(open: true, kind: .failure).questions.first)
		let choice = try #require(question.choices.first { $0.answer == "flaky" })
		let answer = try #require(project.prepareAnswer(question, with: choice))
		let outbox = AnswerOutbox(project: project)
		#expect(answer.projectIdentity == identity)
		let screen = QueueScreen(project: project, outbox: outbox)
		await transport.gate.holdNext()
		let sending = Task { await screen.answer(question, with: choice) }
		try await transport.gate.waitUntilPaused()
		try await replace(key)
		await transport.gate.release()
		#expect(await sending.value == false)
		#expect(screen.notice?.text == "\(question.ref): Obsolete. \(outbox.entries[0].detail)")
		#expect(outbox.entries.map(\.status) == ["Obsolete"])
		#expect(outbox.pendingCount == 0)
		let current = try #require(try await server.account().projects.first { $0.key == key })
		#expect(current.id != identity)
		let replacement = server.project(key, identity: current.id)
		let same = try #require(try await replacement.question(question.ref))
		#expect(same.isOpen)
		// Another send pass does not replay an obsolete command.
		await outbox.send()
		#expect(transport.commands.withLock { $0.count } == 1)
		#expect(try await replacement.answer(same, with: try #require(same.choices.first { $0.answer == "flaky" })).isDecided)
	}

	@Test("cleared earlier answers stay cleared after a second replacement")
	func fileScopes() async throws {
		let server = try await Live.signedIn()
		let project = try await server.project(try await Live.project())
		let question = try #require(try await project.questions(open: true, kind: .failure).questions.first)
		let choice = try #require(question.choices.first { $0.answer == "flaky" })
		let answer = try #require(project.prepareAnswer(question, with: choice))
		let directory = FileManager.default.temporaryDirectory.appending(path: "mw-identity-\(UUID().uuidString)")
		defer { try? FileManager.default.removeItem(at: directory) }
		let old = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: project.identity, directory: directory)
		_ = try AnswerOutbox(project: project, store: old).enqueue(answer)
		let replacement = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: "replacement", directory: directory)
		#expect(old.file != replacement.file)
		let current = AnswerOutbox(project: server.project(project.key, identity: "replacement"), store: replacement)
		#expect(current.entries.map(\.status) == ["Obsolete"])
		#expect(current.pendingCount == 0)
		current.clearOutcomes()
		#expect(AnswerOutbox(project: server.project(project.key, identity: "replacement"), store: replacement).entries.isEmpty)
		let third = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: "third", directory: directory)
		let latest = AnswerOutbox(project: server.project(project.key, identity: "third"), store: third)
		#expect(latest.entries.isEmpty)
		#expect(!FileManager.default.fileExists(atPath: old.file.path))
	}

	@Test("reopening a current file completes interrupted cleanup without touching other scopes", arguments: [false, true])
	func interruptedCleanup(legacy: Bool) async throws {
		let server = try await Live.signedIn()
		let project = try await server.project(try await Live.project())
		let question = try #require(try await project.questions(open: true, kind: .failure).questions.first)
		let choice = try #require(question.choices.first { $0.answer == "flaky" })
		let answer = try #require(project.prepareAnswer(question, with: choice))
		let directory = FileManager.default.temporaryDirectory.appending(path: "mw-interrupted-\(UUID().uuidString)")
		defer { try? FileManager.default.removeItem(at: directory) }
		let old = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: project.identity, directory: directory)
		_ = try AnswerOutbox(project: project, store: old).enqueue(answer)
		let oldData = try Data(contentsOf: old.file)
		let earlierFile = legacy
			? directory.appendingPathComponent(String(old.file.lastPathComponent.split(separator: ".")[0]) + ".json")
			: old.file
		if legacy { try FileManager.default.moveItem(at: old.file, to: earlierFile) }
		let replacement = server.project(project.key, identity: "replacement")
		let store = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: replacement.identity, directory: directory)
		let current = AnswerOutbox(project: replacement, store: store)
		#expect(current.entries.map(\.status) == ["Obsolete"])
		current.clearOutcomes()
		#expect(!FileManager.default.fileExists(atPath: earlierFile.path))
		let currentData = try Data(contentsOf: store.file)
		// Restore the state left by an app stopping after its atomic write, before removing earlier files.
		try oldData.write(to: earlierFile)
		let otherStores = [
			FileAnswerStore(instance: Live.instance, person: 2, project: project.key, identity: project.identity, directory: directory),
			FileAnswerStore(instance: Live.instance, person: 1, project: "other", identity: project.identity, directory: directory),
			FileAnswerStore(instance: try #require(Instance(address: "mainworthy.example")), person: 1, project: project.key, identity: project.identity, directory: directory)
		]
		for other in otherStores { try other.save(oldData) }
		let unreadable = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: "unreadable", directory: directory)
		try unreadable.save(Data("broken".utf8))
		let reopenedStore = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: replacement.identity, directory: directory)
		let reopened = AnswerOutbox(project: replacement, store: reopenedStore)
		#expect(reopened.entries.isEmpty)
		#expect(try Data(contentsOf: store.file) == currentData)
		#expect(reopened.storageProblem == nil)
		#expect(!FileManager.default.fileExists(atPath: earlierFile.path))
		for other in otherStores { #expect(try Data(contentsOf: other.file) == oldData) }
		#expect(try Data(contentsOf: unreadable.file) == Data("broken".utf8))
		let third = server.project(project.key, identity: "third")
		let thirdStore = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: third.identity, directory: directory)
		#expect(AnswerOutbox(project: third, store: thirdStore).entries.isEmpty)
	}

	@Test("a retired outbox cannot recreate its file after a late obsolete refusal")
	func retiredSend() async throws {
		let transport = SwitchableQueueTransport()
		let server = try await Live.signedIn(transport: transport)
		let project = try await server.project(try await Live.project())
		let question = try #require(try await project.questions(open: true, kind: .failure).questions.first)
		let choice = try #require(question.choices.first { $0.answer == "flaky" })
		let directory = FileManager.default.temporaryDirectory.appending(path: "mw-retired-\(UUID().uuidString)")
		defer { try? FileManager.default.removeItem(at: directory) }
		let store = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: project.identity, directory: directory)
		let outbox = AnswerOutbox(project: project, store: store)
		_ = try outbox.enqueue(try #require(project.prepareAnswer(question, with: choice)))
		await transport.gate.holdNext()
		let sending = Task { await outbox.send() }
		try await transport.gate.waitUntilPaused()
		try await replace(project.key)
		outbox.retire()
		let replacement = try await server.project(project.key)
		let replacementStore = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: replacement.identity, directory: directory)
		let current = AnswerOutbox(project: replacement, store: replacementStore)
		#expect(current.entries.map(\.status) == ["Obsolete"])
		current.clearOutcomes()
		#expect(!FileManager.default.fileExists(atPath: store.file.path))
		await transport.gate.release()
		await sending.value
		#expect(!FileManager.default.fileExists(atPath: store.file.path))
		outbox.clearOutcomes()
		#expect(!FileManager.default.fileExists(atPath: store.file.path))
		outbox.retire()
		#expect(!FileManager.default.fileExists(atPath: store.file.path))
		#expect(try await replacement.question(question.ref)?.isOpen == true)
		#expect(AnswerOutbox(project: replacement, store: replacementStore).entries.isEmpty)
		let third = server.project(project.key, identity: "third")
		let thirdStore = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: third.identity, directory: directory)
		#expect(AnswerOutbox(project: third, store: thirdStore).entries.isEmpty)
	}

	@Test("recorded outcomes survive retirement and replacement without clearing current drafts")
	func recordedHistory() async throws {
		let server = try await Live.signedIn()
		let project = try await server.project(try await Live.project())
		let question = try #require(try await project.questions(open: true, kind: .failure).questions.first)
		let choice = try #require(question.choices.first { $0.answer == "flaky" })
		let directory = FileManager.default.temporaryDirectory.appending(path: "mw-recorded-\(UUID().uuidString)")
		defer { try? FileManager.default.removeItem(at: directory) }
		let store = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: project.identity, directory: directory)
		let outbox = AnswerOutbox(project: project, store: store)
		let recorded = try await outbox.record([question], with: choice)
		#expect(recorded.status == "Recorded")
		let outcomes = try #require(recorded.outcomes)
		outbox.retire()
		#expect(outbox.entries[0].status == "Recorded")
		#expect(outbox.entries[0].outcomes == outcomes)
		#expect(outbox.entries[0].members[0].outcome?.isDecided == true)
		#expect(outbox.entries[0].detail == "The server recorded this answer.")
		let replacement = server.project(project.key, identity: "replacement")
		let replacementStore = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: replacement.identity, directory: directory)
		let current = AnswerOutbox(project: replacement, store: replacementStore)
		#expect(current.entries[0].status == "Recorded")
		#expect(current.entries[0].outcome == recorded.outcome)
		let screen = QueueScreen(project: replacement, outbox: current)
		screen.typed[question.ref, default: .init()].reference = "NEW-1"
		await screen.refresh()
		#expect(screen.typed[question.ref]?.reference == "NEW-1")
	}

	@Test("an unreadable earlier file is skipped without blocking new saved answers", arguments: [false, true])
	func unreadableEarlierFile(legacy: Bool) async throws {
		let server = try await Live.signedIn()
		let project = try await server.project(try await Live.project())
		let question = try #require(try await project.questions(open: true, kind: .failure).questions.first)
		let choice = try #require(question.choices.first { $0.answer == "flaky" })
		let directory = FileManager.default.temporaryDirectory.appending(path: "mw-unreadable-\(UUID().uuidString)")
		defer { try? FileManager.default.removeItem(at: directory) }
		let old = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: project.identity, directory: directory)
		_ = try AnswerOutbox(project: project, store: old).enqueue(try #require(project.prepareAnswer(question, with: choice)))
		let corrupt = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: "unreadable", directory: directory)
		let corruptFile = legacy
			? directory.appendingPathComponent(String(old.file.lastPathComponent.split(separator: ".")[0]) + ".json")
			: corrupt.file
		try Data("broken".utf8).write(to: corruptFile)
		let replacement = server.project(project.key, identity: "replacement")
		let store = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: replacement.identity, directory: directory)
		let outbox = AnswerOutbox(project: replacement, store: store)
		#expect(outbox.entries.map(\.status) == ["Obsolete"])
		#expect(outbox.storageProblem == "Some earlier saved answers could not be read and were skipped. You can still save answers for this project.")
		let answer = try #require(replacement.prepareAnswer(question, with: choice))
		let id = try outbox.enqueue(answer)
		#expect(outbox.entries.map(\.status) == ["Obsolete", "Waiting to send"])
		#expect(outbox.storageProblem == nil)
		let reopenedStore = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: replacement.identity, directory: directory)
		let reopened = AnswerOutbox(project: replacement, store: reopenedStore)
		#expect(reopened.entries.last?.id == id)
		#expect(reopened.pendingCount == 1)
		#expect(reopened.storageProblem == nil)
		#expect(AnswerOutbox(project: replacement, store: store).storageProblem == nil)
		#expect(try Data(contentsOf: corruptFile) == Data("broken".utf8))
	}

	@Test("an unreadable current file is kept and blocks new saved answers")
	func unreadableCurrentFile() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		let question = try #require(try await project.questions(open: true, kind: .failure).questions.first)
		let choice = try #require(question.choices.first { $0.answer == "flaky" })
		let answer = try #require(project.prepareAnswer(question, with: choice))
		let directory = FileManager.default.temporaryDirectory.appending(path: "mw-current-\(UUID().uuidString)")
		defer { try? FileManager.default.removeItem(at: directory) }
		let store = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: project.identity, directory: directory)
		try store.save(Data("broken".utf8))
		let outbox = AnswerOutbox(project: project, store: store)
		#expect(outbox.storageProblem?.hasPrefix("Saved answers could not be read. They have not been replaced.") == true)
		#expect(throws: (any Error).self) { try outbox.enqueue(answer) }
		#expect(try Data(contentsOf: store.file) == Data("broken".utf8))
	}

	@Test("a legacy file without an identity is obsolete on disk and never sent")
	func oldFile() async throws {
		let transport = SwitchableQueueTransport()
		let project = try await Live.signedIn(transport: transport).project(try await Live.project())
		let question = try #require(try await project.questions(open: true, kind: .failure).questions.first)
		let directory = FileManager.default.temporaryDirectory.appending(path: "mw-legacy-\(UUID().uuidString)")
		defer { try? FileManager.default.removeItem(at: directory) }
		try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		let store = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: project.identity, directory: directory)
		let legacy = directory.appendingPathComponent(String(store.file.lastPathComponent.split(separator: ".")[0]) + ".json")
		let data = """
		[{"answer":{"command":"old-answer-385","question":"\(question.ref)","title":"Old answer","label":"Flaky","input":{}},"delivery":"unsent"}]
		"""
		try Data(data.utf8).write(to: legacy)
		let outbox = AnswerOutbox(project: project, store: store)
		await outbox.send()
		#expect(outbox.entries.map(\.status) == ["Obsolete"])
		#expect(outbox.entries[0].detail.contains("This app will not send it again."))
		#expect(transport.commands.withLock { $0.count } == 0)
		#expect(try await project.question(question.ref)?.isOpen == true)
		outbox.clearOutcomes()
		#expect(AnswerOutbox(project: project, store: store).entries.isEmpty)
	}

	@Test("foreground account refresh replaces screens and retires the old outbox")
	func foreground() async throws {
		let server = try await Live.signedIn()
		let key = try await Live.project()
		let account = try await server.account()
		let old = try #require(account.projects.first { $0.key == key })
		let defaultsName = "mw-identity-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: defaultsName))
		defer { defaults.removePersistentDomain(forName: defaultsName) }
		let workspace = Workspace(server: server, account: account, remembered: Remembered(defaults), onSignedOut: {})
		workspace.open(old)
		let queue = try #require(workspace.queue)
		await queue.show(.open, filter: nil)
		let question = try #require(queue.questions.first { $0.kind == .failure })
		let client = server.project(key, identity: old.id)
		let choice = try #require(question.choices.first { $0.answer == "flaky" })
		let answer = try #require(client.prepareAnswer(question, with: choice))
		_ = try queue.outbox.enqueue(answer)
		try await replace(key)
		await workspace.refreshAccount()
		let current = try #require(workspace.project)
		defer {
			for identity in [old.id, current.id] {
				try? FileManager.default.removeItem(at: FileAnswerStore(instance: Live.instance, person: account.actorId, project: key, identity: identity).file)
			}
		}
		#expect(current.key == old.key && current.id != old.id)
		#expect(workspace.queue !== queue)
		#expect(queue.outbox.entries.map(\.status) == ["Obsolete"])
		#expect(workspace.queue?.outbox.entries.map(\.status) == ["Obsolete"])
		#expect(workspace.queue?.outbox.pendingCount == 0)
	}
}
