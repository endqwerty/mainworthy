import Foundation
import MainworthyClient
import Synchronization
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("The queue screen", .enabled(if: Live.isRunning, "needs the server `bun scripts/ios.ts test` starts"))
@MainActor
struct QueueScreenTests {
	func screen(strict: Bool = false) async throws -> QueueScreen {
		let screen = QueueScreen(project: try await Live.signedIn().project(try await Live.project(strict: strict)))
		await screen.show(.open, filter: nil)
		return screen
	}

	@Test("an answer during a network drop waits on the device without claiming a decision")
	func offlineAnswer() async throws {
		let transport = SwitchableQueueTransport()
		let server = try await Live.signedIn(transport: transport)
		let screen = QueueScreen(project: try await server.project(try await Live.project()))
		await screen.show(.open, filter: nil)
		let question = try #require(screen.questions.first { $0.kind == .failure })
		let choice = try #require(question.choices.first { $0.answer == "flaky" })
		transport.offline.withLock { $0 = true }
		#expect(await screen.answer(question, with: choice) == false)
		#expect(screen.current(question.ref)?.isOpen == true)
		#expect(screen.notice?.text == "\(question.ref): saved on this device, waiting to send. Open Unsent answers to see its outcome.")
	}

	@Test("saved answers survive a restart and are sent in order with the original evidence and command")
	func durableFIFO() async throws {
		let transport = SwitchableQueueTransport()
		let server = try await Live.signedIn(transport: transport)
		let project = try await server.project(try await Live.project())
		let directory = URL.cachesDirectory.appending(path: "mainworthy-outbox-\(UUID().uuidString)")
		defer { try? FileManager.default.removeItem(at: directory) }
		let store = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: "test-identity", directory: directory)
		let outbox = AnswerOutbox(project: project, store: store)
		let screen = QueueScreen(project: project, outbox: outbox)
		await screen.show(.open, filter: nil)
		let failure = try #require(screen.questions.first { $0.kind == .failure })
		let finding = try #require(screen.questions.first { $0.kind == .finding })
		transport.offline.withLock { $0 = true }
		#expect(await screen.answer(failure, with: try #require(failure.choices.first { $0.answer == "defect" }), reference: "SHOP-482", reason: "Checked on the phone") == false)
		#expect(await screen.answer(finding, with: try #require(finding.choices.first { $0.answer == "defer" })) == false)
		// A second tap cannot replace or duplicate an answer already saved.
		#expect(await screen.answer(failure, with: try #require(failure.choices.first { $0.answer == "flaky" })) == false)
		#expect(outbox.pendingCount == 2)
		#expect(try URL(filePath: store.file.path).resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
		var root = directory
		#expect(try URL(filePath: root.path).resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
		// A file written by an earlier build must gain the exclusion when read, too.
		var included = URLResourceValues()
		included.isExcludedFromBackup = false
		var file = store.file
		try file.setResourceValues(included)
		try root.setResourceValues(included)
		let reopened = AnswerOutbox(project: project, store: store)
		#expect(reopened.entries == outbox.entries)
		#expect(try URL(filePath: file.path).resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
		#expect(try URL(filePath: root.path).resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
		#expect(reopened.entries.map(\.question) == [failure.ref, finding.ref])
		transport.commands.withLock { $0 = [] }
		transport.offline.withLock { $0 = false }
		await reopened.send()
		#expect(reopened.entries.map(\.status) == ["Recorded", "Recorded"])
		let sent = try transport.commands.withLock { try $0.map { try JSONDecoder().decode(JSONValue.self, from: $0) } }
		#expect(sent.map { decisions($0).map { $0["q"]?.string } } == [[failure.ref], [finding.ref]])
		#expect(sent.map { $0["cmd"]?.string } == outbox.entries.map { Optional($0.id) })
		#expect(decisions(sent[0]).first?["onEvidence"]?.string == failure.evidenceHash)
		#expect(decisions(sent[0]).first?["answer"]?["ref"]?.string == "SHOP-482")
		#expect(sent[0]["reason"]?.string == "Checked on the phone")
		let recorded = try #require(try await project.question(failure.ref))
		#expect(recorded.decision?.reference == "SHOP-482" && recorded.decision?.reason == "Checked on the phone")
		#expect(AnswerOutbox(project: project, store: store).entries.map(\.status) == ["Recorded", "Recorded"])
		#expect(try URL(filePath: file.path).resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
		reopened.clearOutcomes()
		#expect(AnswerOutbox(project: project, store: store).entries.isEmpty)
	}

	@Test("dropping a stuck answer checks its command and preserves the next answer", arguments: [false, true])
	func dropStuckAnswer(recorded: Bool) async throws {
		let transport = SwitchableQueueTransport()
		let server = try await Live.signedIn(transport: transport)
		let project = try await server.project(try await Live.project())
		let questions = try await project.questions(open: true).questions
		let failure = try #require(questions.first { $0.kind == .failure })
		let finding = try #require(questions.first { $0.kind == .finding })
		let flaky = try #require(failure.choices.first { $0.answer == "flaky" })
		let deferChoice = try #require(finding.choices.first { $0.answer == "defer" })
		let first = try #require(project.prepareAnswer(failure, with: flaky))
		let next = try #require(project.prepareAnswer(finding, with: deferChoice))
		let store = MemoryAnswerStore()
		let outbox = AnswerOutbox(project: project, store: store)
		_ = try outbox.enqueue(first)
		_ = try outbox.enqueue(next)
		if recorded { transport.loseReply.withLock { $0 = true } }
		else { transport.serverProblem.withLock { $0 = ("internal", "The answer could not be recorded.") } }
		await outbox.send()
		#expect(outbox.pendingCount == 2)
		transport.loseReply.withLock { $0 = false }
		transport.offline.withLock { $0 = false }
		transport.serverProblem.withLock { $0 = nil }
		transport.commands.withLock { $0 = [] }
		// Recovery must work on an entry restored from disk, with the original command.
		let reopened = AnswerOutbox(project: project, store: store)
		await reopened.drop(first.command)
		#expect(reopened.pendingCount == 0)
		let checked = try transport.lookups.withLock { try $0.map { try JSONDecoder().decode(JSONValue.self, from: $0) } }
		#expect(checked == [["cmd": .string(first.command)]])
		let sent = try transport.commands.withLock { try $0.map { try JSONDecoder().decode(JSONValue.self, from: $0) } }
		#expect(sent.map { $0["cmd"]?.string } == [next.command])
		#expect(try await project.question(finding.ref)?.isOpen == false)
		if recorded {
			let decision = try #require(try await project.question(failure.ref)?.ifDecision)
			#expect(reopened.entries.first?.outcome == .decided(decision))
			#expect(reopened.entries.map(\.status) == ["Recorded", "Recorded"])
		} else {
			#expect(reopened.entries.map(\.id) == [next.command])
			#expect(reopened.entries.first?.status == "Recorded")
			#expect(try await project.question(failure.ref)?.isOpen == true)
		}
		#expect(AnswerOutbox(project: project, store: store).entries == reopened.entries)
	}

	@Test("a dropped timed-out answer survives relaunch, lets later answers send, and recovers late delivery", arguments: ["timeout", "retry error", "later error"])
	func lateDroppedAnswer(failure: String) async throws {
		let transport = LateAnswerTransport()
		let server = try await Live.signedIn(transport: transport)
		let project = try await server.project(try await Live.project())
		let questions = try await project.questions(open: true).questions
		let question = try #require(questions.first { $0.kind == .failure })
		let finding = try #require(questions.first { $0.kind == .finding })
		let flaky = try #require(question.choices.first { $0.answer == "flaky" })
		let deferred = try #require(finding.choices.first { $0.answer == "defer" })
		let first = try #require(project.prepareAnswer(question, with: flaky))
		let next = try #require(project.prepareAnswer(finding, with: deferred))
		let store = MemoryAnswerStore()
		let outbox = AnswerOutbox(project: project, store: store)
		_ = try outbox.enqueue(first)
		_ = try outbox.enqueue(next)
		transport.rejectRetries.withLock { $0 = failure == "retry error" }
		await outbox.send()
		#expect(outbox.pendingCount == 2)
		if failure == "later error" {
			transport.rejectRetries.withLock { $0 = true }
			await outbox.send()
		}
		transport.holding.withLock { $0 = false }
		await outbox.drop(first.command)
		#expect(outbox.entries.map(\.status) == ["Dropped", "Recorded"])
		#expect(outbox.pendingCount == 0)
		#expect(try await project.question(question.ref)?.isOpen == true)
		#expect(try await project.question(finding.ref)?.isOpen == false)
		outbox.clearOutcomes()
		let reopened = AnswerOutbox(project: project, store: store)
		#expect(reopened.entries.map(\.id) == [first.command])
		#expect(reopened.entries.first?.status == "Dropped")
		let sentBefore = transport.sent.withLock { $0 }
		await reopened.send()
		#expect(transport.sent.withLock { $0 } == sentBefore)
		#expect(reopened.entries.first?.status == "Dropped")
		try await transport.deliverHeld()
		await reopened.send()
		let decision = try #require(try await project.question(question.ref)?.ifDecision)
		#expect(reopened.entries.first?.outcome == .decided(decision))
		#expect(reopened.entries.first?.status == "Recorded")
		#expect(transport.sent.withLock { $0 } == sentBefore)
		#expect(AnswerOutbox(project: project, store: store).entries == reopened.entries)
		reopened.clearOutcomes()
		#expect(AnswerOutbox(project: project, store: store).entries.isEmpty)
	}

	@Test("waiting answers record before dropped checks, which stop after a network failure", arguments: [false, true])
	func waitingBeforeDroppedChecks(lookupFails: Bool) async throws {
		let transport = SwitchableQueueTransport()
		let server = try await Live.signedIn(transport: transport)
		let project = try await server.project(try await Live.project())
		let questions = try await project.questions(open: true).questions
		let failure = try #require(questions.first { $0.kind == .failure })
		let finding = try #require(questions.first { $0.kind == .finding })
		let flaky = try #require(failure.choices.first { $0.answer == "flaky" })
		let outbox = AnswerOutbox(project: project)
		for _ in 0..<2 {
			let answer = try #require(project.prepareAnswer(failure, with: flaky))
			_ = try outbox.enqueue(answer)
			transport.offline.withLock { $0 = true }
			await outbox.send()
			transport.offline.withLock { $0 = false }
			await outbox.drop(answer.command)
		}
		#expect(outbox.entries.map(\.status) == ["Dropped", "Dropped"])
		let deferChoice = try #require(finding.choices.first { $0.answer == "defer" })
		let next = try #require(project.prepareAnswer(finding, with: deferChoice))
		_ = try outbox.enqueue(next)
		transport.commands.withLock { $0 = [] }
		transport.lookups.withLock { $0 = [] }
		transport.lookupFails.withLock { $0 = lookupFails }
		await transport.lookupGate.holdNext()
		let sending = Task { await outbox.send() }
		try await transport.lookupGate.waitUntilPaused()
		#expect(outbox.entries.last?.status == "Recorded")
		#expect(try await project.question(finding.ref)?.isOpen == false)
		let sent = try transport.commands.withLock { try $0.map { try JSONDecoder().decode(JSONValue.self, from: $0) } }
		#expect(sent.map { $0["cmd"]?.string } == [next.command])
		await transport.lookupGate.release()
		await sending.value
		let checked = try transport.lookups.withLock { try $0.map { try JSONDecoder().decode(JSONValue.self, from: $0) } }
		let ids = outbox.entries.prefix(2).map { Optional($0.id) }
		#expect(checked.map { $0["cmd"]?.string } == (lookupFails ? [ids[0], ids[0]] : ids))
		#expect(outbox.entries.map(\.status) == ["Dropped", "Dropped", "Recorded"])
	}

	@Test("an answer saved during dropped checks sends in the same pass or pauses on failure", arguments: [false, true], [false, true])
	func answerDuringDroppedChecks(lookupFails: Bool, answerFails: Bool) async throws {
		let (outbox, project, transport, _) = try await stuckAnswer()
		transport.offline.withLock { $0 = true }
		await outbox.send()
		transport.offline.withLock { $0 = false }
		await outbox.drop(try #require(outbox.stuck?.id))
		#expect(outbox.entries.map(\.status) == ["Dropped"])
		let screen = QueueScreen(project: project, outbox: outbox)
		await screen.show(.open, filter: nil)
		let finding = try #require(screen.questions.first { $0.kind == .finding })
		let choice = try #require(finding.choices.first { $0.answer == "defer" })
		transport.commands.withLock { $0 = [] }
		transport.lookups.withLock { $0 = [] }
		transport.lookupFails.withLock { $0 = lookupFails }
		await transport.lookupGate.holdNext()
		let sending = Task { await outbox.send() }
		try await transport.lookupGate.waitUntilPaused()
		if answerFails { transport.serverProblem.withLock { $0 = ("internal", "Not recorded.") } }
		let answering = Task { await screen.answer(finding, with: choice) }
		let deadline = ContinuousClock.now.advanced(by: .seconds(3))
		while outbox.pendingCount == 0, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
		#expect(outbox.pendingCount == 1)
		await transport.lookupGate.release()
		await sending.value
		let settled = await answering.value
		#expect(settled == !answerFails)
		if answerFails {
			#expect(outbox.entries.map(\.status) == ["Dropped", "Waiting to send"])
			#expect(outbox.stuck?.detail == "Not recorded. The saved answer is waiting to send.")
			#expect(screen.notice?.text == "\(finding.ref): saved on this device, waiting to send. Open Unsent answers to see its outcome.")
		} else {
			#expect(outbox.entries.map(\.status) == ["Dropped", "Recorded"])
			#expect(screen.notice?.text == "\(finding.ref): \(choice.label).")
		}
		#expect(!screen.busy.contains(finding.ref))
		#expect(try await project.question(finding.ref)?.isOpen == answerFails)
		let sent = try transport.commands.withLock { try $0.map { try JSONDecoder().decode(JSONValue.self, from: $0) } }
		#expect(sent.map { $0["cmd"]?.string } == [outbox.entries.last?.id])
		#expect(transport.lookups.withLock { $0.count } == (lookupFails ? 2 : 1))
	}

	@Test("the screen confirms an answer before slow dropped checks finish")
	func confirmsBeforeDroppedChecks() async throws {
		let (outbox, project, transport, _) = try await stuckAnswer()
		transport.offline.withLock { $0 = true }
		await outbox.send()
		transport.offline.withLock { $0 = false }
		await outbox.drop(try #require(outbox.stuck?.id))
		let screen = QueueScreen(project: project, outbox: outbox)
		await screen.show(.open, filter: nil)
		let finding = try #require(screen.questions.first { $0.kind == .finding })
		let choice = try #require(finding.choices.first { $0.answer == "defer" })
		await transport.lookupGate.holdNext()
		var settled: Bool?
		let answering = Task { settled = await screen.answer(finding, with: choice) }
		try await transport.lookupGate.waitUntilPaused()
		let deadline = ContinuousClock.now.advanced(by: .seconds(3))
		while settled == nil, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
		#expect(settled == true)
		#expect(screen.notice?.text == "\(finding.ref): \(choice.label).")
		#expect(!screen.busy.contains(finding.ref))
		#expect(try await project.question(finding.ref)?.isOpen == false)
		await transport.lookupGate.release()
		await answering.value
		// Join the pass if answer() already returned before its dropped lookup.
		let finished = ContinuousClock.now.advanced(by: .seconds(3))
		while outbox.sending, ContinuousClock.now < finished { try await Task.sleep(for: .milliseconds(10)) }
		#expect(outbox.sending == false)
	}

	@Test("an older saved answer without delivery metadata stays dropped on none")
	func legacyDrop() async throws {
		let (outbox, project, _, store) = try await stuckAnswer()
		let id = try #require(outbox.stuck?.id)
		let data = try #require(store.data)
		var rows = try #require(try JSONDecoder().decode(JSONValue.self, from: data).array)
		var row = try #require(rows[0].object)
		row.removeValue(forKey: "delivery")
		rows[0] = .object(row)
		store.data = try JSONEncoder().encode(JSONValue.array(rows))
		let reopened = AnswerOutbox(project: project, store: store)
		await reopened.drop(id)
		#expect(reopened.entries.map(\.status) == ["Dropped"])
		let dropped = try #require(reopened.entries.first)
		#expect(try await project.question(dropped.question)?.isOpen == true)
	}

	@Test("possible delivery is saved before a request leaves the device")
	func deliverySavedBeforeSend() async throws {
		let (outbox, project, transport, store) = try await stuckAnswer()
		let entry = try #require(outbox.stuck)
		await transport.gate.holdNext()
		let sending = Task { await outbox.send() }
		try await transport.gate.waitUntilPaused()
		outbox.stop()
		// Restore the disk state before the paused request can produce a reply.
		let reopened = AnswerOutbox(project: project, store: store)
		await reopened.drop(entry.id)
		#expect(reopened.entries.map(\.status) == ["Dropped"])
		await transport.gate.release()
		await sending.value
		await reopened.send()
		#expect(reopened.entries.first?.status == "Recorded")
		#expect(try await project.question(entry.question)?.isOpen == false)
	}

	@Test("a lookup pause that never happens fails rather than hanging")
	func boundedLookupWait() async throws {
		let gate = QueueSendGate()
		do {
			try await gate.waitUntilPaused(timeout: .milliseconds(20))
			Issue.record("a gate with no request unexpectedly paused")
		} catch GateTimeout.neverPaused {}
	}

	func stuckAnswer() async throws -> (AnswerOutbox, ProjectClient, SwitchableQueueTransport, SwitchableAnswerStore) {
		let transport = SwitchableQueueTransport()
		let server = try await Live.signedIn(transport: transport)
		let project = try await server.project(try await Live.project())
		let question = try #require(try await project.questions(open: true, kind: .failure).questions.first)
		let choice = try #require(question.choices.first { $0.answer == "flaky" })
		let store = SwitchableAnswerStore()
		let outbox = AnswerOutbox(project: project, store: store)
		_ = try outbox.enqueue(try #require(project.prepareAnswer(question, with: choice)))
		transport.serverProblem.withLock { $0 = ("internal", "The answer could not be recorded.") }
		await outbox.send()
		#expect(outbox.stuck?.detail == "The answer could not be recorded. The saved answer is waiting to send.")
		transport.serverProblem.withLock { $0 = nil }
		transport.commands.withLock { $0 = [] }
		return (outbox, project, transport, store)
	}

	@Test("dropping keeps the answer when the command cannot be settled", arguments: ["offline", "begun", "unreadable", "wrong question", "empty reply", "storage"])
	func dropCannotSettle(problem: String) async throws {
		let (outbox, project, transport, store) = try await stuckAnswer()
		let entry = try #require(outbox.stuck)
		let before = store.data
		switch problem {
		case "offline": transport.offline.withLock { $0 = true }
		case "begun": transport.commandReply.withLock { $0 = ["state": "begun"] }
		case "unreadable": transport.commandReply.withLock { $0 = ["state": "done"] }
		case "wrong question": transport.commandReply.withLock { $0 = ["state": "done", "reply": [["q": "Q-999", "status": "decided", "decision": 42]]] }
		case "empty reply": transport.commandReply.withLock { $0 = ["state": "done", "reply": []] }
		case "storage": store.fail = true
		default: Issue.record("unknown test problem")
		}
		await outbox.drop(entry.id)
		#expect(outbox.entries == [entry])
		#expect(store.data == before)
		#expect(!outbox.sending)
		#expect(transport.commands.withLock { $0.isEmpty })
		if problem == "offline" {
			#expect(outbox.dropProblem?.hasPrefix("The command could not be checked. The saved answer was kept. The server could not be reached.") == true)
		} else if problem == "begun" {
			#expect(outbox.dropProblem == "The server is still recording this answer. It was kept. Keep trying resends the same answer and command id.")
		} else if problem == "storage" {
			#expect(outbox.storageProblem?.hasPrefix("The saved answer could not be updated on this device. It was kept.") == true)
		} else {
			#expect(outbox.dropProblem?.hasPrefix("The command could not be checked. The saved answer was kept. The reply could not be read.") == true)
		}
		transport.offline.withLock { $0 = false }
		transport.commandReply.withLock { $0 = nil }
		store.fail = false
		await outbox.send()
		#expect(outbox.entries.first?.status == "Recorded")
		#expect(try await project.question(entry.question)?.isOpen == false)
	}

	@Test("dropping serializes with sending and preserves saves made during lookup", arguments: [false, true])
	func dropDuringLookup(stopped: Bool) async throws {
		let (outbox, project, transport, store) = try await stuckAnswer()
		let first = try #require(outbox.stuck)
		let question = try #require(try await project.questions(open: true, kind: .finding).questions.first)
		let choice = try #require(question.choices.first { $0.answer == "defer" })
		let next = try #require(project.prepareAnswer(question, with: choice))
		await transport.lookupGate.holdNext()
		let dropping = Task { await outbox.drop(first.id) }
		try await transport.lookupGate.waitUntilPaused()
		#expect(outbox.sending)
		await outbox.send()
		await outbox.drop(first.id)
		_ = try outbox.enqueue(next)
		outbox.clearOutcomes()
		if stopped { outbox.stop() }
		await transport.lookupGate.release()
		await dropping.value
		if stopped {
			#expect(outbox.entries.map(\.id) == [first.id, next.command])
			#expect(outbox.pendingCount == 2)
			#expect(transport.commands.withLock { $0.isEmpty })
		} else {
			#expect(outbox.entries.map(\.id) == [next.command])
			#expect(outbox.entries.first?.status == "Recorded")
		}
		#expect(AnswerOutbox(project: project, store: store).entries == outbox.entries)
		#expect(try await project.question(first.question)?.isOpen == true)
	}

	@Test("dropping cannot interrupt an answer already being sent")
	func dropDuringSend() async throws {
		let (outbox, _, transport, _) = try await stuckAnswer()
		let entry = try #require(outbox.stuck)
		await transport.gate.holdNext()
		let sending = Task { await outbox.send() }
		try await transport.gate.waitUntilPaused()
		await outbox.drop(entry.id)
		#expect(transport.lookups.withLock { $0.isEmpty })
		#expect(outbox.entries.map(\.id) == [entry.id])
		#expect(outbox.entries.first?.problem == entry.problem)
		#expect(outbox.entries.first?.status == "Waiting to send")
		await transport.gate.release()
		await sending.value
		#expect(outbox.entries.first?.status == "Recorded")
	}

	@MainActor final class SwitchableAnswerStore: AnswerStore {
		var data: Data?
		var fail = false
		func load() throws -> Data? { data }
		func save(_ data: Data) throws {
			if fail { throw CocoaError(.fileWriteOutOfSpace) }
			self.data = data
		}
	}

	@Test("an answer saved offline cannot replace another person's decision on unchanged evidence")
	func decidedWhileOffline() async throws {
		let transport = SwitchableQueueTransport()
		let server = try await Live.signedIn(transport: transport)
		let project = try await server.project(try await Live.project())
		let screen = QueueScreen(project: project)
		await screen.show(.open, filter: nil)
		let question = try #require(screen.questions.first { $0.kind == .failure })
		let flaky = try #require(question.choices.first { $0.answer == "flaky" })
		let defect = try #require(question.choices.first { $0.answer == "defect" })
		transport.offline.withLock { $0 = true }
		#expect(await screen.answer(question, with: flaky) == false)
		#expect(screen.outbox.pendingCount == 1)
		let owner = try await Live.signedIn(as: Live.owner)
		let other = try await owner.project(project.key)
		guard case .decided(let decision) = try await other.answer(question, with: defect, reference: "SHOP-1", reason: "Checked by another person") else {
			Issue.record("the other person's answer was not recorded")
			return
		}
		let before = try #require(try await other.question(question.ref))
		#expect(!before.isOpen && before.evidenceHash == question.evidenceHash)
		transport.offline.withLock { $0 = false }
		await screen.outbox.send()
		let entry = try #require(screen.outbox.entries.first)
		#expect(entry.status == "Overtaken")
		#expect(entry.outcome == .overtaken("the question is no longer open; read it again before answering"))
		#expect(entry.detail.contains("Read the question again and choose an answer on its current evidence."))
		#expect(screen.outbox.pendingCount == 0)
		let after = try #require(try await other.question(question.ref))
		#expect(after.ifDecision == decision && after.decision?.label == "Defect in the product")
		#expect(after.decision?.reference == "SHOP-1" && after.decision?.reason == "Checked by another person")
	}

	@Test("an online answer queued during another send confirms when its result is saved")
	func answerDuringSend() async throws {
		let transport = SwitchableQueueTransport()
		let server = try await Live.signedIn(transport: transport)
		let screen = QueueScreen(project: try await server.project(try await Live.project()))
		await screen.show(.open, filter: nil)
		let failure = try #require(screen.questions.first { $0.kind == .failure })
		let finding = try #require(screen.questions.first { $0.kind == .finding })
		let flaky = try #require(failure.choices.first { $0.answer == "flaky" })
		let deferChoice = try #require(finding.choices.first { $0.answer == "defer" })
		await transport.gate.holdNext()
		let first = Task { await screen.answer(failure, with: flaky) }
		try await transport.gate.waitUntilPaused()
		let next = Task { await screen.answer(finding, with: deferChoice) }
		let deadline = ContinuousClock.now.advanced(by: .seconds(3))
		while screen.outbox.pendingCount < 2, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
		#expect(screen.outbox.pendingCount == 2)
		await transport.gate.release()
		#expect(await first.value)
		#expect(await next.value)
		#expect(screen.outbox.entries.map(\.status) == ["Recorded", "Recorded"])
	}

	@Test("an uncertain server error ends its sentence before the waiting explanation", arguments: ["Something broke", "Something broke."])
	func waitingErrorSentence(message: String) async throws {
		let transport = SwitchableQueueTransport()
		let server = try await Live.signedIn(transport: transport)
		let screen = QueueScreen(project: try await server.project(try await Live.project()))
		await screen.show(.open, filter: nil)
		let question = try #require(screen.questions.first { $0.kind == .failure })
		let flaky = try #require(question.choices.first { $0.answer == "flaky" })
		transport.serverProblem.withLock { $0 = ("internal", message) }
		#expect(await screen.answer(question, with: flaky) == false)
		#expect(screen.outbox.entries.first?.detail == "Something broke. The saved answer is waiting to send.")
	}

	@Test("a reply lost after recording replays the same command after a restart")
	func lostReply() async throws {
		let transport = SwitchableQueueTransport()
		let server = try await Live.signedIn(transport: transport)
		let project = try await server.project(try await Live.project())
		let question = try #require(try await project.questions(open: true, kind: .failure).questions.first)
		let store = MemoryAnswerStore()
		let outbox = AnswerOutbox(project: project, store: store)
		let flaky = try #require(question.choices.first { $0.answer == "flaky" })
		let answer = try #require(project.prepareAnswer(question, with: flaky))
		_ = try outbox.enqueue(answer)
		transport.loseReply.withLock { $0 = true }
		await outbox.send()
		#expect(outbox.pendingCount == 1)
		let observer = try await Live.signedIn().project(project.key)
		let decision = try #require(try await observer.question(question.ref)?.ifDecision)
		#expect(try await observer.question(question.ref)?.isOpen == false)
		transport.loseReply.withLock { $0 = false }
		transport.offline.withLock { $0 = false }
		let reopened = AnswerOutbox(project: project, store: store)
		await reopened.send()
		#expect(reopened.entries.first?.outcome == .decided(decision))
		#expect(try await observer.question(question.ref)?.ifDecision == decision)
		let sent = try transport.commands.withLock { try $0.map { try JSONDecoder().decode(JSONValue.self, from: $0) } }
		#expect(sent.count == 4)
		#expect(sent.allSatisfy { $0 == sent[0] && $0["cmd"]?.string == answer.command })
		#expect(decisions(sent[0]).allSatisfy { $0["ifOpen"] == true })
	}

	@Test("changed evidence and refusals have separate outcomes and do not stop the next saved answer")
	func refusedAndOvertaken() async throws {
		let project = try await Live.signedIn().project(try await Live.project(strict: true))
		let question = try #require(try await project.questions(open: true, kind: .signoff).questions.first)
		let choice = try #require(question.choices.first { $0.answer == "approve" })
		let refused = try #require(project.prepareAnswer(question, with: choice))
		// Restore an answer saved against older evidence, then let the real server judge it.
		var captured = try #require(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(refused)).object)
		var input = try #require(captured["input"]?.object)
		var decision = try #require(input["all"]?.array?.first?.object)
		decision["onEvidence"] = "older-evidence"
		input["all"] = [.object(decision)]
		captured["input"] = .object(input)
		captured["command"] = .string(UUID().uuidString.lowercased())
		let stale = try JSONDecoder().decode(PreparedAnswer.self, from: JSONEncoder().encode(JSONValue.object(captured)))
		let store = MemoryAnswerStore()
		let outbox = AnswerOutbox(project: project, store: store)
		_ = try outbox.enqueue(stale)
		await outbox.send()
		#expect(outbox.entries.first?.status == "Overtaken")
		#expect(outbox.entries.first?.detail.contains("Read the question again and choose an answer on its current evidence.") == true)
		#expect(try await project.question(question.ref)?.isOpen == true)
		_ = try outbox.enqueue(refused)
		await outbox.send()
		#expect(outbox.entries.map(\.status) == ["Overtaken", "Refused"])
		#expect(outbox.entries.last?.outcome == .notTaken("a reason"))
		_ = try outbox.enqueue(try #require(project.prepareAnswer(question, with: choice, reason: "Checked the release build")))
		await outbox.send()
		#expect(outbox.entries.map(\.status) == ["Overtaken", "Refused", "Recorded"])
		#expect(try await project.question(question.ref)?.decision?.reason == "Checked the release build")
	}

	@Test("saved files are isolated by instance, person and project")
	func scopes() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		let question = try #require(try await project.questions(open: true, kind: .failure).questions.first)
		let flaky = try #require(question.choices.first { $0.answer == "flaky" })
		let answer = try #require(project.prepareAnswer(question, with: flaky))
		let directory = URL.cachesDirectory.appending(path: "mainworthy-outbox-\(UUID().uuidString)")
		defer { try? FileManager.default.removeItem(at: directory) }
		let store = FileAnswerStore(instance: Live.instance, person: 1, project: project.key, identity: "test-identity", directory: directory)
		_ = try AnswerOutbox(project: project, store: store).enqueue(answer)
		let same = AnswerOutbox(project: project, store: store)
		#expect(same.entries.map(\.label) == ["Flaky"])
		for other in [
			FileAnswerStore(instance: Live.instance, person: 2, project: project.key, identity: "test-identity", directory: directory),
			FileAnswerStore(instance: Live.instance, person: 1, project: "other", identity: "test-identity", directory: directory),
			FileAnswerStore(instance: try #require(Instance(address: "mainworthy.example")), person: 1, project: project.key, identity: "test-identity", directory: directory)
		] { #expect(AnswerOutbox(project: project, store: other).entries.isEmpty) }
		same.stop()
		await same.send()
		#expect(same.pendingCount == 1)
		#expect(try await project.question(question.ref)?.isOpen == true)
	}

	@Test("saving another answer during a send preserves both, including a new workspace after sign-out", arguments: [false, true])
	func concurrentSave(stopped: Bool) async throws {
		let transport = SwitchableQueueTransport()
		let server = try await Live.signedIn(transport: transport)
		let project = try await server.project(try await Live.project())
		let questions = try await project.questions(open: true).questions
		let failure = try #require(questions.first { $0.kind == .failure })
		let finding = try #require(questions.first { $0.kind == .finding })
		let flaky = try #require(failure.choices.first { $0.answer == "flaky" })
		let deferChoice = try #require(finding.choices.first { $0.answer == "defer" })
		let store = MemoryAnswerStore()
		let outbox = AnswerOutbox(project: project, store: store)
		_ = try outbox.enqueue(try #require(project.prepareAnswer(failure, with: flaky)))
		await transport.gate.holdNext()
		let sending = Task { await outbox.send() }
		try await transport.gate.waitUntilPaused()
		if stopped { outbox.stop() }
		let resumed = stopped ? AnswerOutbox(project: project, store: store) : outbox
		_ = try resumed.enqueue(try #require(project.prepareAnswer(finding, with: deferChoice)))
		resumed.clearOutcomes()
		if !stopped { await resumed.send() }
		await transport.gate.release()
		await sending.value
		if stopped { await resumed.send() }
		#expect(resumed.entries.map(\.status) == ["Recorded", "Recorded"])
		let sent = try transport.commands.withLock { try $0.map { try JSONDecoder().decode(JSONValue.self, from: $0) } }
		#expect(sent.map { decisions($0).first?["q"]?.string } == (stopped ? [failure.ref, failure.ref, finding.ref] : [failure.ref, finding.ref]))
	}

	@Test("opening another project does not strand a saved answer when the stream reconnects")
	func projectSwitchReplay() async throws {
		let transport = SwitchableQueueTransport()
		let server = try await Live.signedIn(transport: transport)
		let firstKey = try await Live.project()
		let secondKey = try await Live.project()
		let account = try await server.account()
		let defaultsName = "mainworthy-outbox-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: defaultsName))
		defer { defaults.removePersistentDomain(forName: defaultsName) }
		let workspace = Workspace(server: server, account: account, remembered: Remembered(defaults), onSignedOut: {})
		workspace.open(try #require(account.projects.first { $0.key == firstKey }))
		let queue = try #require(workspace.queue)
		let file = FileAnswerStore(instance: Live.instance, person: account.actorId, project: firstKey, identity: try #require(account.projects.first { $0.key == firstKey }).id).file
		defer { try? FileManager.default.removeItem(at: file) }
		await queue.show(.open, filter: nil)
		let question = try #require(queue.questions.first { $0.kind == .failure })
		transport.offline.withLock { $0 = true }
		await queue.answer(question, with: try #require(question.choices.first { $0.answer == "flaky" }))
		#expect(queue.outbox.pendingCount == 1)
		workspace.open(try #require(account.projects.first { $0.key == secondKey }))
		transport.offline.withLock { $0 = false }
		let follow = Task { await workspace.follow() }
		defer { follow.cancel() }
		for _ in 0..<100 where queue.outbox.pendingCount > 0 { try await Task.sleep(for: .milliseconds(20)) }
		#expect(queue.outbox.entries.first?.status == "Recorded")
		workspace.open(try #require(account.projects.first { $0.key == firstKey }))
		#expect(workspace.queue?.outbox === queue.outbox)
		#expect(try await server.project(firstKey).question(question.ref)?.decision?.label == "Flaky")
	}

	@Test("it shows what is open, the failure first, and says how much needs an answer")
	func lists() async throws {
		let screen = try await screen()
		#expect(screen.loading == .done)
		#expect(screen.questions.map(\.kind) == [.failure, .adopt, .finding, .map])
		#expect(screen.counts.phrase == "1 failure to explain · 3 can wait")
		#expect(!screen.hasMore)
	}

	@Test("a map question offers linking on the phone")
	func nativeLink() async throws {
		let screen = try await screen()
		let question = try #require(screen.questions.first { $0.kind == .map })
		let link = try #require(question.choices.first { $0.answer == "link" })
		#expect(link.takes != .more)
	}

	@Test("an answer leaves the list, the screen says what was recorded, and Undo asks the question again")
	func answerAndUndo() async throws {
		let screen = try await screen()
		let failure = try #require(screen.questions.first)
		let flaky = try #require(failure.choices.first { $0.answer == "flaky" })
		#expect(await screen.answer(failure, with: flaky))
		#expect(screen.current(failure.ref) == nil)
		#expect(screen.counts.open == 3)
		#expect(screen.notice?.text == "\(failure.ref): Flaky.")
		#expect(screen.notice?.isProblem == false)
		let undoes = try #require(screen.notice?.undoes)
		await screen.withdraw(undoes)
		#expect(screen.current(failure.ref) != nil)
		#expect(screen.notice == .init(text: "\(failure.ref): the decision is withdrawn.", isProblem: false, undoes: nil))
		#expect(screen.busy.isEmpty)
	}

	@Test("Undo keeps its receipt when another answer replaces it", arguments: [false, true])
	func staleUndo(fromDecided: Bool) async throws {
		let key = try await Live.project()
		let screen = QueueScreen(project: try await Live.signedIn().project(key))
		await screen.show(.open, filter: nil)
		let failure = try #require(screen.questions.first { $0.kind == .failure })
		#expect(await screen.answer(failure, with: try #require(failure.choices.first { $0.answer == "flaky" })))
		let undo: Question
		if fromDecided {
			await screen.show(.decided, filter: .failure)
			undo = try #require(screen.questions.first)
		} else {
			undo = try #require(screen.notice?.undoes)
		}
		let otherServer = try await Live.signedIn()
		let other = try await otherServer.project(key)
		// A separate API client deliberately replaces the decision, which the phone queue cannot do.
		let replacement: [JSONValue] = try await otherServer.write("decide", in: key, [
			"q": .string(failure.ref), "onEvidence": .string(failure.evidenceHash), "answer": ["is": "defect"],
		])
		#expect(replacement.first?["status"]?.string == "decided")
		#expect(await screen.withdraw(undo) == false)
		#expect(screen.notice?.isProblem == true)
		#expect(screen.notice?.text == "Withdrawal of \(failure.ref) was not confirmed. Server response: the decision changed; read the question again before withdrawing.")
		let standing = try #require(try await other.questions(open: false, kind: .failure).questions.first)
		#expect(standing.decision?.label == "Defect in the product")
	}

	@Test("the decided list shows who decided, and a filter shows one kind")
	func decidedAndFilter() async throws {
		let screen = try await screen()
		let finding = try #require(screen.questions.first { $0.kind == .finding })
		#expect(await screen.answer(finding, with: try #require(finding.choices.first { $0.answer == "defer" })))
		await screen.show(.decided, filter: nil)
		let decided = try #require(screen.questions.first { $0.ref == finding.ref })
		#expect(decided.decision?.label == "Defer" && decided.decision?.by == [Live.name])
		await screen.show(.open, filter: .map)
		#expect(screen.questions.map(\.kind) == [.map])
		// The counts stay the whole project's, so the filters can say how many each would show.
		#expect(screen.counts.open == 3 && screen.counts.open(of: .failure) == 1)
	}

	@Test("an accepted edit is not offered to undo: the case's history is where it is undone")
	func acceptedEdit() async throws {
		let screen = try await screen()
		let adopt = try #require(screen.questions.first { $0.kind == .adopt })
		// An edit nobody was shown is not accepted: the answer waits for what it changes to be read.
		let accept = try #require(adopt.choices.first { $0.answer == "accept" })
		#expect(!screen.isShown(adopt))
		#expect(await screen.answer(adopt, with: accept) == false)
		#expect(screen.notice?.text == "Nothing was recorded for \(adopt.ref): what it asks about has not been shown yet.")
		#expect(screen.current(adopt.ref) != nil)
		await screen.readDocuments(of: adopt)
		guard case .read(let documents) = screen.documents(of: adopt) else {
			Issue.record("what the edit changes was not read")
			return
		}
		#expect(documents.count == 1 && screen.isShown(adopt))
		#expect(await screen.answer(adopt, with: accept))
		#expect(screen.notice?.text == "\(adopt.ref): Accept.")
		#expect(screen.notice?.undoes == nil)
	}

	@Test("an answer the policy does not take is said so, in the server's words, and the question stays")
	func notTaken() async throws {
		let screen = try await screen(strict: true)
		let signoff = try #require(screen.questions.first { $0.kind == .signoff })
		let approve = try #require(signoff.choices.first { $0.answer == "approve" })
		// What is typed in the sheet is the screen's, and stays when the server does not take the answer.
		screen.typed[signoff.ref, default: .init()].reference = "SHOP-1"
		#expect(await screen.answer(signoff, with: approve) == false)
		#expect(screen.typed[signoff.ref]?.reference == "SHOP-1")
		#expect(screen.notice?.text == "Nothing was recorded for \(signoff.ref). The server asks for a reason.")
		#expect(screen.notice?.isProblem == true)
		#expect(screen.current(signoff.ref) != nil)
		#expect(await screen.answer(signoff, with: approve, reason: "Checked on the release build."))
		#expect(screen.current(signoff.ref) == nil)
		#expect(screen.typed[signoff.ref] == nil)
		// Undo is offered, and withdrawing is a decision too: the policy asks it for a reason as well.
		let undoes = try #require(screen.notice?.undoes)
		#expect(undoes.wantsReason)
		// A withdrawal that was not taken says so, and the question's page stays to show why.
		#expect(await screen.withdraw(undoes) == false)
		#expect(screen.notice?.text == "Withdrawal of \(signoff.ref) was not confirmed. Server response: a reason.")
		#expect(await screen.withdraw(undoes, reason: "Closed too early."))
		#expect(screen.notice?.text == "\(signoff.ref): the decision is withdrawn.")
		#expect(screen.current(signoff.ref) != nil)
	}

	@Test("an open question opens from another screen while this list shows the decided ones, and can be answered")
	func openedWhileShowingDecided() async throws {
		let screen = try await screen()
		let failure = try #require(screen.questions.first { $0.kind == .failure })
		await screen.show(.decided, filter: nil)
		#expect(screen.current(failure.ref) == nil)
		// The page of a change opens the question, and the queue's tab is on its other list.
		await screen.open(failure.ref)
		let opened = try #require(screen.current(failure.ref))
		#expect(opened.isOpen && opened.standing == .counts && screen.isShown(opened))
		#expect(await screen.answer(opened, with: try #require(opened.choices.first { $0.answer == "flaky" })))
		// Answered, its page shows it as decided, with who decided.
		#expect(screen.current(failure.ref)?.decision?.label == "Flaky")
	}

	@Test("a change made elsewhere is on the screen after it is read again")
	func refresh() async throws {
		let server = try await Live.signedIn()
		let key = try await Live.project()
		let screen = QueueScreen(project: try await server.project(key))
		await screen.show(.open, filter: nil)
		// Somebody else answers: the same project, another connection.
		let other = try await Live.signedIn().project(key)
		let failure = try #require(try await other.questions(open: true, kind: .failure).questions.first)
		_ = try await other.answer(failure, with: try #require(failure.choices.first { $0.answer == "infra" }))
		#expect(screen.current(failure.ref) != nil)
		await screen.refresh()
		#expect(screen.current(failure.ref) == nil)
	}
}

@Suite("The queue screen, when the server does not answer")
@MainActor
struct QueueScreenFailureTests {
	/// A transport that never reaches anything.
	struct Down: Transport {
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			throw URLError(.cannotConnectToHost)
		}

		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			throw URLError(.cannotConnectToHost)
		}
	}

	/// A queue of three questions that the server hands out two at a time.
	struct TwoPages: Transport {
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			func question(_ ref: String) -> String {
				"""
				{"q":"\(ref)","kind":"map","title":"Tests with no case","producer":"ci","state":"open","evidenceHash":"abc",
				"evidence":{"file":"a.spec.ts","tests":[],"count":0,"facts":[]},"seen":{"count":1,"carried":0},
				"needs":"one member","answers":["track"],"blocks":[],"about":[],"openedAt":1800000000000,"advice":[],
				"decision":null,"you":"counts"}
				"""
			}
			let asked = String(decoding: request.httpBody ?? Data(), as: UTF8.self)
			if request.url?.lastPathComponent == "get" {
				// One question by its ref: Q-3 is open, and Q-9 was decided since.
				let body = asked.contains("Q-9")
					? question("Q-9").replacingOccurrences(of: #""state":"open""#, with: #""state":"decided""#)
					: question("Q-3")
				return (
					Data(#"{"ok":true,"seq":1,"result":[\#(body)]}"#.utf8),
					HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
				)
			}
			let second = asked.contains(#""cursor":"next""#)
			let items = second ? question("Q-3") : "\(question("Q-1")),\(question("Q-2"))"
			let body = #"{"ok":true,"seq":1,"result":{"counts":{"open":3,"map":3},"cursor":\#(second ? "null" : #""next""#),"items":[\#(items)]}}"#
			return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
		}

		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			throw URLError(.unsupportedURL)
		}
	}

	@Test("unreadable saved answers and a failed save never send or overwrite the file")
	func storageFailure() async throws {
		let server = Server(instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: TwoPages())
		let project = server.project("shop", identity: "shop-identity")
		let question = try #require(try await project.questions(open: true).questions.first)
		let choice = try #require(question.choices.first)
		let prepared = try #require(project.prepareAnswer(question, with: choice))
		let corrupt = MemoryAnswerStore()
		corrupt.data = Data("broken".utf8)
		let unreadable = AnswerOutbox(project: project, store: corrupt)
		#expect(unreadable.storageProblem?.contains("could not be read") == true)
		#expect(throws: (any Error).self) { try unreadable.enqueue(prepared) }
		unreadable.clearOutcomes()
		await unreadable.send()
		#expect(corrupt.data == Data("broken".utf8))
		let refused = AnswerOutbox(project: project, store: FailingAnswerStore())
		#expect(throws: (any Error).self) { try refused.enqueue(prepared) }
		#expect(refused.entries.isEmpty && refused.pendingCount == 0)
	}

	struct FailingAnswerStore: AnswerStore {
		func load() throws -> Data? { nil }
		func save(_ data: Data) throws { throw CocoaError(.fileWriteOutOfSpace) }
	}

	@Test("a list that was read past its first page is read as far again, so an open question stays in it")
	func refreshKeepsPages() async throws {
		let server = Server(instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: TwoPages())
		let screen = QueueScreen(project: server.project("shop", identity: "shop-identity"))
		await screen.show(.open, filter: nil)
		#expect(screen.questions.map(\.ref) == ["Q-1", "Q-2"] && screen.hasMore)
		await screen.more()
		#expect(screen.questions.map(\.ref) == ["Q-1", "Q-2", "Q-3"] && !screen.hasMore)
		// Somebody writes in the project, and the list is read again while Q-3 is open.
		await screen.refresh()
		#expect(screen.current("Q-3") != nil)
		#expect(screen.questions.count == 3 && !screen.hasMore)
	}

	@Test("a question whose page is open is read by itself where the list does not hold it")
	func openedBeyondTheList() async throws {
		let server = Server(instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: TwoPages())
		let screen = QueueScreen(project: server.project("shop", identity: "shop-identity"))
		await screen.show(.open, filter: nil)
		// The list was read as far as Q-2. Q-3 is opened from another screen, or pushed down by a new question.
		#expect(screen.current("Q-3") == nil)
		await screen.open("Q-3")
		#expect(screen.current("Q-3")?.isOpen == true)
		await screen.refresh()
		#expect(screen.questions.count == 2 && screen.current("Q-3") != nil)
		// A page shows its question whatever the list shows: one that was decided is shown as decided.
		await screen.open("Q-9")
		#expect(screen.current("Q-9")?.isOpen == false)
		screen.close("Q-9")
		#expect(screen.current("Q-9") == nil)
	}

	@Test("a proposal that is decided is read again, so it no longer says that accepting is refused")
	func decidedProposalIsReadAgain() async throws {
		let key = try await Live.project()
		let owner = try await Live.signedIn(as: Live.owner)
		let screen = QueueScreen(project: try await Live.signedIn().project(key))
		await screen.show(.open, filter: .adopt)
		let open = try #require(screen.questions.first)
		// The case gets a third step of its own while the agent's edit, which adds one too, waits.
		let _: JSONValue = try await owner.write("propose", in: key, [
			"edits": [[
				"op": "edit", "case": "C-2", "base": 1,
				"body": ["steps": [
					["id": "s1", "action": "Open the cart with one $100.00 item", "expected": .null],
					["id": "s2", "action": "Apply the coupon SAVE10", "expected": "Total shows $90.00"],
					["id": "s3", "action": "A different third step", "expected": .null],
				]],
			]],
		])
		await screen.readDocuments(of: open)
		guard case .read(let waiting) = screen.documents(of: open) else {
			Issue.record("the open proposal was not read")
			return
		}
		#expect(waiting.first?.refused?.hasPrefix("C-2 changed after this proposal was made") == true)
		#expect(await screen.answer(open, with: try #require(open.choices.first { $0.answer == "reject" })))
		await screen.show(.decided, filter: .adopt)
		let decided = try #require(screen.questions.first { $0.ref == open.ref })
		#expect(!decided.isOpen && decided.evidenceHash == open.evidenceHash)
		await screen.readDocuments(of: decided)
		guard case .read(let settled) = screen.documents(of: decided) else {
			Issue.record("the decided proposal was not read")
			return
		}
		#expect(settled.count == 1 && settled.first?.refused == nil)
	}

	@Test("the first read that fails says why, in place of the list")
	func firstReadFails() async throws {
		let server = Server(instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: Down())
		let screen = QueueScreen(project: server.project("shop", identity: "shop-identity"))
		await screen.show(.open, filter: nil)
		guard case .failed(let why) = screen.loading else {
			Issue.record("the screen did not say the read failed")
			return
		}
		#expect(why.hasPrefix("The server could not be reached."))
		#expect(screen.questions.isEmpty)
	}
}

final class SwitchableQueueTransport: Transport, Sendable {
	let offline = Mutex(false)
	let loseReply = Mutex(false)
	let serverProblem = Mutex<(code: String, message: String)?>(nil)
	let commands = Mutex<[Data]>([])
	let lookups = Mutex<[Data]>([])
	let commandReply = Mutex<JSONValue?>(nil)
	let gate = QueueSendGate()
	let lookupGate = QueueSendGate()
	let lookupFails = Mutex(false)
	private let inner = URLSessionTransport()

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		if request.url?.lastPathComponent == "command", let body = request.httpBody {
			lookups.withLock { $0.append(body) }
			await lookupGate.pauseIfNeeded()
			if lookupFails.withLock({ $0 }) { throw URLError(.timedOut) }
			if let reply = commandReply.withLock({ $0 }) {
				let body: JSONValue = ["ok": true, "result": reply]
				return (try JSONEncoder().encode(body), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
			}
		}
		if request.url?.lastPathComponent == "decide", let body = request.httpBody {
			commands.withLock { $0.append(body) }
			await gate.pauseIfNeeded()
			if let problem = serverProblem.withLock({ $0 }) {
				let body: JSONValue = ["ok": false, "error": ["code": .string(problem.code), "message": .string(problem.message)]]
				return (try JSONEncoder().encode(body), HTTPURLResponse(url: request.url!, statusCode: problem.code == "internal" ? 500 : 403, httpVersion: nil, headerFields: nil)!)
			}
		}
		if offline.withLock({ $0 }) { throw URLError(.notConnectedToInternet) }
		let reply = try await inner.send(request)
		if request.url?.lastPathComponent == "decide", loseReply.withLock({ $0 }) {
			offline.withLock { $0 = true }
			throw URLError(.networkConnectionLost)
		}
		return reply
	}

	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		if offline.withLock({ $0 }) { throw URLError(.notConnectedToInternet) }
		return try await inner.lines(request)
	}
}

actor QueueSendGate {
	private var holding = false
	private var paused: CheckedContinuation<Void, Never>?
	func holdNext() { holding = true }
	func pauseIfNeeded() async {
		guard holding else { return }
		holding = false
		await withCheckedContinuation { continuation in
			paused = continuation
		}
	}
	func waitUntilPaused(timeout: Duration = .seconds(3)) async throws {
		let deadline = ContinuousClock.now.advanced(by: timeout)
		while paused == nil {
			guard ContinuousClock.now < deadline else { throw GateTimeout.neverPaused }
			try await Task.sleep(for: .milliseconds(10))
		}
	}
	func release() { paused?.resume(); paused = nil }
}

private enum GateTimeout: Error { case neverPaused }

private final class LateAnswerTransport: Transport, Sendable {
	let holding = Mutex(true)
	let rejectRetries = Mutex(false)
	let held = Mutex<[URLRequest]>([])
	let sent = Mutex(0)
	private let inner = URLSessionTransport()

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		if request.url?.lastPathComponent == "decide" {
			sent.withLock { $0 += 1 }
			if holding.withLock({ $0 }) {
				if rejectRetries.withLock({ $0 }), held.withLock({ !$0.isEmpty }) {
					let body: JSONValue = ["ok": false, "error": ["code": "internal", "message": "Not recorded."]]
					return (try JSONEncoder().encode(body), HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!)
				}
				held.withLock { $0.append(request) }
				throw URLError(.timedOut)
			}
		}
		return try await inner.send(request)
	}

	func deliverHeld() async throws {
		for request in held.withLock({ $0 }) { _ = try await inner.send(request) }
	}

	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		try await inner.lines(request)
	}
}

/// The answers a `decide` request carried: each of an `all`, or the one of an earlier build's request.
func decisions(_ request: JSONValue) -> [JSONValue] {
	request["all"]?.array ?? [request]
}
