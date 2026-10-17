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

	@Test("a change lists its runs, newest first, and each one reads what its gate counted")
	func runs() async throws {
		let server = Live.server()
		_ = try await server.signIn(Live.owner)
		let client = server.project(try await Live.project())
		let screen = ChangesScreen(project: client)
		await screen.refresh()
		await screen.open("pr:482")
		let first = try #require(screen.runs.first)
		#expect(screen.runs.count == 1)
		let _: JSONValue = try await server.write("report", in: client.key, [
			"target": ["commit": .string(String(repeating: "5", count: 40)), "repo": "acme/shop",
				"branch": "coupon-total", "pr": 482],
			"job": "review", "results": [["test": ["key": "review-pass"], "outcome": "pass"]]
		])
		await screen.refresh()
		#expect(screen.runs.map(\.ref).last == first.ref && screen.runs.count == 2)
		let newest = try #require(screen.runs.first)
		guard case .commit(let commit, _, _) = newest.accepts else {
			Issue.record("\(newest.ref) accepts no commit")
			return
		}
		#expect(commit == String(repeating: "5", count: 40))
		let older = screen.results(of: first)
		await older.load()
		#expect(older.loading == .done && older.total > 0 && older.run == first.ref)
	}

	@Test("a change remains readable outside the newest 500, with its new head and its end")
	func capEvictsDetail() async throws {
		let server = Live.server()
		_ = try await server.signIn(Live.owner)
		let client = server.project(try await Live.project())
		let screen = ChangesScreen(project: client)
		await screen.refresh()
		await screen.open("pr:482")
		#expect(screen.detail?.gate.verdict == .blocked)
		func report(_ number: Int, pr: Int) async throws {
			let _: JSONValue = try await server.write("report", in: client.key, [
				"target": ["commit": .string(String(format: "%040x", number)), "repo": "acme/shop",
					"branch": .string("review-\(pr)"), "pr": .number(Double(pr))],
				"job": "review", "results": [["test": ["key": "review-pass"], "outcome": "pass"]]
			])
		}
		// Move the open change and end it, then put enough others ahead of it to fill the list.
		try await report(4, pr: 482)
		let _: JSONValue = try await server.write("change", in: client.key, ["change": "pr:482", "state": "merged"])
		for number in 0..<501 { try await report(1000 + number, pr: 1000 + number) }
		await screen.refresh()
		let gate: JSONValue = try await server.read("gate", in: client.key, ["change": "pr:482"])
		print("CAP_EVICTION list=\(screen.changes.count) " +
			"oldPresent=\(screen.changes.contains { $0.key == "pr:482" }) " +
			"detail=\(screen.detail == nil ? "nil" : "present") " +
			"loading=\(screen.detailLoading) oldGateStillExists=\(gate.object != nil)")
		#expect(screen.changes.count == 500 && !screen.changes.contains { $0.key == "pr:482" })
		#expect(screen.detail != nil, "the open page must not depend on membership in a capped list")
		#expect(screen.detailLoading == .done && screen.detail?.gate.verdict == .passed)
		#expect(screen.detail?.change.head == String(format: "%040x", 4))
		#expect(screen.detail?.change.branch == "coupon-total")
		// Its end is read with it, not taken from the list it fell out of (the second review's finding).
		#expect(screen.detail?.change.state == .merged)
		await screen.refresh()
		#expect(screen.detail?.change.state == .merged)
	}

	@Test("a change is read by key before its list has been loaded")
	func openWithoutList() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let screen = ChangesScreen(project: client)
		await screen.open("pr:482")
		#expect(screen.changes.isEmpty && screen.detailLoading == .done)
		#expect(screen.detail?.change.key == "pr:482" && screen.detail?.gate.verdict == .blocked)
		#expect(screen.detail?.change.head == String(repeating: "3", count: 40))
		#expect(screen.detail?.change.branch == "coupon-total")
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
		// Answered, its page shows it as decided, whatever the queue's list shows.
		#expect(queue.current(failure.ref)?.decision?.label == "Flaky")
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
		guard case .failed(let detailWhy) = screen.detailLoading else {
			Issue.record("the failed detail read was not shown"); return
		}
		#expect(detailWhy.hasPrefix("The server could not be reached."))
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
