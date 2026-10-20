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

	@Test("replacement files are separate and display earlier answers as obsolete")
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
		#expect(AnswerOutbox(project: project, store: old).pendingCount == 1)
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
		#expect(outbox.entries[0].detail.contains("never be sent"))
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
