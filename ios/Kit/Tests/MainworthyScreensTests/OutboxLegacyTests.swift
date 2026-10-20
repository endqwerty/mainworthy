import Foundation
import MainworthyClient
import Synchronization
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("Saved answers across builds", .enabled(if: Live.isRunning, "needs the server `bun scripts/ios.ts test` starts"))
@MainActor
struct OutboxLegacyTests {
	@Test("answers without a project identity become obsolete and are never sent")
	func earlierBuild() async throws {
		let transport = SwitchableQueueTransport()
		let project = try await Live.signedIn(transport: transport).project(try await Live.project())
		let questions = try await project.questions(open: true).questions
		let failure = try #require(questions.first { $0.kind == .failure })
		let finding = try #require(questions.first { $0.kind == .finding })
		// The file an earlier build wrote: one question per answer, and the outcome of one that was recorded.
		let waiting = """
			{"answer":{"command":"legacy-\(UUID().uuidString.lowercased())","question":"\(failure.ref)","title":"\(failure.title)",
			"label":"Flaky","input":{"q":"\(failure.ref)","onEvidence":"\(failure.evidenceHash)","answer":{"is":"flaky"},"ifOpen":true}},
			"delivery":"unsent"}
			"""
		let recorded = """
			{"answer":{"command":"legacy-done","question":"\(finding.ref)","title":"A finding","label":"Defer",
			"input":{"q":"\(finding.ref)","onEvidence":"h","answer":{"is":"defer"},"ifOpen":true}},
			"delivery":"uncertain","outcome":{"decided":{"_0":12}}}
			"""
		let store = MemoryAnswerStore()
		store.data = Data("[\(recorded),\(waiting)]".utf8)
		let outbox = AnswerOutbox(project: project, store: store)
		#expect(outbox.storageProblem == nil)
		#expect(outbox.entries.map(\.questions) == [[finding.ref], [failure.ref]])
		#expect(outbox.entries[0].outcome == nil && outbox.entries[0].status == "Obsolete")
		#expect(outbox.pendingCount == 0)
		transport.commands.withLock { $0 = [] }
		await outbox.send()
		#expect(outbox.entries.map(\.status) == ["Obsolete", "Obsolete"])
		// Sent as the earlier build wrote it: the server ties the command id to that request.
		let sent = try transport.commands.withLock { try $0.map { try JSONDecoder().decode(JSONValue.self, from: $0) } }
		#expect(sent.isEmpty)
		#expect(try await project.question(failure.ref)?.isOpen == true)
		// Saved again in this build's form, it reads back the same.
		#expect(AnswerOutbox(project: project, store: store).entries == outbox.entries)
	}

	@Test("a test's page is read again on a change only while it is open")
	func shownTests() async throws {
		let transport = CountingReads()
		let screen = TestsScreen(project: try await Live.signedIn(transport: transport).project(try await Live.project()))
		await screen.open("T-1")
		await screen.open("T-2")
		screen.close("T-1")
		transport.reads.withLock { $0 = [] }
		await screen.refresh()
		#expect(transport.reads.withLock { $0 } == ["T-2"])
		screen.close("T-2")
		transport.reads.withLock { $0 = [] }
		await screen.refresh()
		#expect(transport.reads.withLock { $0 }.isEmpty)
	}
}

/// Counts the tests read by ref.
final class CountingReads: Transport, Sendable {
	let reads = Mutex<[String]>([])
	private let inner = URLSessionTransport()

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		if request.url?.lastPathComponent == "get", let body = request.httpBody,
			let refs = try? JSONDecoder().decode(JSONValue.self, from: body)["refs"]?.array
		{
			reads.withLock { $0 += refs.compactMap(\.string).filter { $0.hasPrefix("T-") } }
		}
		return try await inner.send(request)
	}

	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		try await inner.lines(request)
	}
}
