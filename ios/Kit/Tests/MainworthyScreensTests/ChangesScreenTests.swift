import Foundation
import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("The changes screen", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
@MainActor
struct ChangesScreenTests {
	@Test("refresh updates both list and open detail after an answer elsewhere")
	func refresh() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let screen = ChangesScreen(project: client)
		await screen.refresh()
		#expect(screen.loading == .done && screen.changes.count == 1)
		await screen.open("pr:482")
		#expect(screen.detailLoading == .done && screen.detail?.gate.verdict == .blocked)
		let failure = try #require(screen.detail?.questions.first { $0.kind == .failure })
		_ = try await client.answer(failure, with: try #require(failure.choices.first { $0.answer == "flaky" }))
		await screen.refresh()
		#expect(screen.changes.first?.verdict == .passed && screen.detail?.gate.verdict == .passed)
	}

	@Test("a question reached from Changes opens outside a queue filter and refreshes after an answer")
	func externalQuestion() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let queue = QueueScreen(project: client)
		await queue.show(.open, filter: .map)
		let failure = try #require(try await client.questions(open: true, kind: .failure).questions.first)
		#expect(queue.current(failure.ref) == nil)
		await queue.open(failure.ref)
		#expect(queue.current(failure.ref) == failure && queue.questions.allSatisfy { $0.kind == .map })
		#expect(await queue.answer(failure, with: try #require(failure.choices.first { $0.answer == "flaky" })))
		// Answered, it is no longer one of the questions that wait, which is what this list shows.
		#expect(queue.current(failure.ref) == nil)
	}
}

@Suite("Changes reads that fail or are overtaken")
@MainActor
struct ChangesReadTests {
	actor FirstReadWaits: Transport {
		nonisolated let began: AsyncStream<Void>
		private let signal: AsyncStream<Void>.Continuation
		private var held: CheckedContinuation<Void, Never>?
		private var reads = 0

		init() {
			let stream = AsyncStream<Void>.makeStream()
			began = stream.stream
			signal = stream.continuation
		}

		func finish() { held?.resume(); held = nil }

		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			reads += 1
			let first = reads == 1
			if first {
				signal.yield()
				await withCheckedContinuation { held = $0 }
			}
			let title = first ? "Old title" : "New title"
			let body = #"{"ok":true,"result":{"items":[{"key":"pr:1","title":"\#(title)","state":"open"}]}}"#
			return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
		}

		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			throw URLError(.unsupportedURL)
		}
	}

	@Test("a late list does not replace the newer one")
	func overtaken() async throws {
		let transport = FirstReadWaits()
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: transport
		)
		let screen = ChangesScreen(project: server.project("shop"))
		let first = Task { await screen.refresh() }
		for await _ in transport.began { break }
		await screen.refresh()
		await transport.finish()
		await first.value
		#expect(screen.changes.first?.title == "New title")
	}

	@Test("the first failure says why, and an unavailable detail says so")
	func failure() async throws {
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: QueueScreenFailureTests.Down()
		)
		let screen = ChangesScreen(project: server.project("shop"))
		await screen.refresh()
		guard case .failed(let why) = screen.loading else { Issue.record("the failed read was not shown"); return }
		#expect(why.hasPrefix("The server could not be reached."))
		await screen.open("pr:missing")
		#expect(screen.detailLoading == .failed("This change is no longer in the reported list."))
	}

	@Test("a question beyond the queue's loaded page can be opened by ref")
	func questionOnNextPage() async throws {
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: QueueScreenFailureTests.TwoPages()
		)
		let queue = QueueScreen(project: server.project("shop"))
		await queue.show(.open, filter: nil)
		#expect(queue.current("Q-3") == nil)
		await queue.open("Q-3")
		#expect(queue.current("Q-3")?.ref == "Q-3" && queue.questions.count == 2)
		await queue.refresh()
		#expect(queue.current("Q-3") != nil && queue.questions.count == 2)
	}
}
