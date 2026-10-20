import Foundation
import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("The results of a change and the tests", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
@MainActor
struct ResultsScreensTests {
	@Test("a change's page reads its results once asked, filters them, and follows an answer given elsewhere")
	func changeResults() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let screen = ChangesScreen(project: client)
		await screen.refresh()
		await screen.open("pr:482")
		let results = try #require(screen.results)
		#expect(results.change == "pr:482" && results.run == screen.detail?.gate.run && results.run != nil)
		#expect(results.loading == .first && results.rows.isEmpty)
		await results.load()
		#expect(results.loading == .done && results.total == 5 && results.rows.count == 5 && !results.hasMore)
		await results.show(.unexplained)
		#expect(results.rows.map(\.name) == ["Shop check 1"] && results.total == 5)
		await results.show(nil)
		results.text = "shipping"
		await results.search()
		#expect(results.rows.map(\.caseRef) == [nil])
		results.text = ""
		await results.search()
		let failure = try #require(screen.detail?.questions.first { $0.kind == .failure })
		_ = try await client.answer(failure, with: try #require(failure.choices.first { $0.answer == "flaky" }))
		await screen.refresh()
		#expect(results.tally[.excused] == 1 && results.rows.first?.standing == .excused)
		// The same change keeps its results; another change gets its own.
		await screen.open("pr:482")
		#expect(screen.results === results)
	}

	@Test("a page refused because the results changed reads the first page again")
	func moved() async throws {
		let server = Live.server()
		_ = try await server.signIn(Live.owner)
		let client = try await server.project(try await Live.project())
		let _: JSONValue = try await server.write("report", in: client.key, [
			"target": ["commit": .string(String(repeating: "3", count: 40)), "repo": "acme/shop", "pr": 482],
			"job": "bulk",
			"results": .array((1...120).map { number in
				["test": ["key": .string("bulk-\(number)")], "outcome": "pass"]
			}),
		])
		let run = try await client.details(of: "pr:482").gate.run
		let results = ChangeResults(project: client, change: "pr:482", run: run)
		await results.load()
		#expect(results.rows.count == 100 && results.hasMore && results.count == 125)
		let failure = try #require(try await client.questions(open: true, kind: .failure).questions.first)
		_ = try await client.answer(failure, with: try #require(failure.choices.first { $0.answer == "flaky" }))
		await results.more()
		#expect(results.moved && !results.hasMore && results.rows.count == 100)
		await results.restart()
		#expect(!results.moved && results.hasMore && results.tally[.excused] == 1)
		await results.more()
		#expect(results.rows.count == 125 && Set(results.rows.map(\.id)).count == 125 && !results.hasMore)
		// Read again from the change stream, the list is read as far down as it was.
		await results.refresh()
		#expect(results.rows.count == 125)
	}

	@Test("the results shown are the shown gate's, and a newer head's gate brings its own")
	func shownHead() async throws {
		let key = try await Live.project()
		let screen = ChangesScreen(project: try await Live.signedIn().project(key))
		await screen.refresh()
		await screen.open("pr:482")
		let shown = try #require(screen.results)
		let owner = Live.server()
		_ = try await owner.signIn(Live.owner)
		let _: JSONValue = try await owner.write("report", in: key, [
			"target": ["commit": .string(String(repeating: "9", count: 40)), "repo": "acme/shop", "pr": 482],
			"job": "new-head", "results": [["test": ["key": "other-head", "name": "Only the newer head ran this"], "outcome": "pass"]],
		])
		// The page still shows the older head's gate: its results are that gate's, read after the new report.
		await shown.load()
		#expect(shown.total == 5 && !shown.rows.contains { $0.name == "Only the newer head ran this" })
		await screen.refresh()
		let newer = try #require(screen.results)
		#expect(newer !== shown && newer.run == screen.detail?.gate.run && newer.run != shown.run)
		await newer.load()
		#expect(newer.rows.map(\.name) == ["Only the newer head ran this"])
	}

	@Test("a slower read of a test does not replace a newer one")
	func staleTest() async throws {
		let key = try await Live.project()
		let transport = HeldReply("get")
		let screen = TestsScreen(project: try await Live.signedIn(transport: transport).project(key))
		await transport.gate.holdNext()
		let old = Task { await screen.open("T-5") }
		try await transport.gate.waitUntilPaused()
		let owner = Live.server()
		_ = try await owner.signIn(Live.owner)
		let _: JSONValue = try await owner.write("report", in: key, [
			"target": ["commit": .string(String(repeating: "3", count: 40)), "repo": "acme/shop", "pr": 482],
			"job": "again", "results": [["test": ["key": "tests/shipping.spec.ts::shipping::address"], "outcome": "fail"]],
		])
		await screen.open("T-5")
		guard case .read(let fresh) = screen.detail("T-5") else {
			Issue.record("the newer read failed")
			return
		}
		#expect(fresh.results.count == 2 && fresh.results.first?.outcome == "fail")
		await transport.gate.release()
		await old.value
		#expect(screen.detail("T-5") == .read(fresh))
	}

	@Test("the tests, those with no case, and a test's page")
	func tests() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let screen = TestsScreen(project: client)
		await screen.refresh()
		#expect(screen.loading == .first, "nothing is read for a list nobody opened")
		await screen.load()
		#expect(screen.loading == .done && screen.tests.count == 5)
		await screen.showUnlinked(true)
		let tracked = try #require(screen.tests.first)
		#expect(screen.tests.count == 1 && tracked.caseRef == nil)
		await screen.open(tracked.ref)
		guard case .read(let detail) = screen.detail(tracked.ref) else {
			Issue.record("the test was not read: \(String(describing: screen.detail(tracked.ref)))")
			return
		}
		#expect(detail.name == "Shipping accepts an address" && detail.results.count == 1)
		await screen.open("T-999")
		#expect(screen.detail("T-999") == .missing)
		screen.text = "check"
		await screen.search()
		#expect(screen.tests.isEmpty, "only tests with no case are shown, and none of them is a check")
		await screen.showUnlinked(false)
		#expect(screen.tests.count == 4)
	}
}

/// Holds the reply of the next request to one operation until the test releases it.
final class HeldReply: Transport, Sendable {
	let gate = QueueSendGate()
	private let operation: String
	private let inner = URLSessionTransport()

	init(_ operation: String) { self.operation = operation }

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let reply = try await inner.send(request)
		if request.url?.lastPathComponent == operation { await gate.pauseIfNeeded() }
		return reply
	}

	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		try await inner.lines(request)
	}
}
