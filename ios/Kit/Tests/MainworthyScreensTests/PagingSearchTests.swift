import Foundation
import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("Search while reading a paged list")
@MainActor
struct PagingSearchTests {
	@Test("typing again after search starts replaces the canceled query", arguments: [false, true])
	func typingWhileReading(results: Bool) async throws {
		let transport = SearchReplies(results: results)
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: transport)
		let project = server.project("shop", identity: "shop-identity")
		let tests = TestsScreen(project: project)
		let counted = ChangeResults(project: project, change: "pr:1", run: "R-1")
		if results { await counted.load() } else { await tests.load() }
		#expect(results ? counted.rows.map(\.name) == ["All"] : tests.tests.map(\.name) == ["All"])

		if results { counted.text = "a" } else { tests.text = "a" }
		// The debounce has elapsed when this read reaches the transport.
		let older = Task { if results { await counted.search() } else { await tests.search() } }
		await transport.untilHeld()
		#expect(results ? counted.loading == .reading : tests.loading == .reading)
		older.cancel()
		if results { counted.text = "ab" } else { tests.text = "ab" }
		// The same initial-loading guards used by the two SwiftUI text tasks.
		let newer = Task {
			if results {
				guard counted.loading != .first else { return }
				await counted.search()
			} else {
				guard tests.loading != .first else { return }
				await tests.search()
			}
		}
		await newer.value
		await transport.release()
		await older.value
		#expect(await transport.texts == ["", "a", "ab"])
		#expect(results ? counted.rows.map(\.name) == ["ab"] : tests.tests.map(\.name) == ["ab"])
		#expect(results ? counted.loading == .done : tests.loading == .done)
	}

	@Test("long pasted searches say on screen that only their beginning is searched", arguments: [false, true])
	func longPaste(results: Bool) async throws {
		let transport = SearchReplies(results: results)
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: transport)
		let project = server.project("shop", identity: "shop-identity")
		let tests = TestsScreen(project: project)
		let counted = ChangeResults(project: project, change: "pr:1", run: "R-1")
		if results { await counted.load() } else { await tests.load() }
		let pastes: [(String, String)] = [
			(String(repeating: "x", count: 201), String(repeating: "x", count: 200)),
			(String(repeating: "🧪", count: 101), String(repeating: "🧪", count: 100)),
			(String(repeating: "x", count: 199) + "🧪tail", String(repeating: "x", count: 199)),
			(String(repeating: "e\u{301}", count: 101), String(repeating: "e\u{301}", count: 100)),
			("  " + String(repeating: "x", count: 201) + "  ", String(repeating: "x", count: 200)),
			(String(repeating: "x", count: 195) + "👨‍👩‍👧‍👦tail", String(repeating: "x", count: 195)),
		]
		for (paste, expected) in pastes {
			if results { counted.text = paste } else { tests.text = paste }
			#expect(results ? counted.text == paste : tests.text == paste)
			if results { await counted.search() } else { await tests.search() }
			#expect((results ? counted.searchNote : tests.searchNote) == "Only the beginning of this text is searched.")
			#expect(await transport.texts.last == expected)
			#expect(results ? counted.rows.map(\.name) == [expected] : tests.tests.map(\.name) == [expected])
			#expect(results ? counted.loading == .done : tests.loading == .done)
		}
		await transport.refuse(true)
		if results { await counted.read() } else { await tests.read() }
		#expect((results ? counted.notice : tests.notice) == "Search refused.")
		#expect((results ? counted.searchNote : tests.searchNote) == "Only the beginning of this text is searched.")
		await transport.refuse(false)
		let boundary = String(repeating: "x", count: 200)
		if results { counted.text = "  " + boundary + "  "; await counted.search() }
		else { tests.text = "  " + boundary + "  "; await tests.search() }
		#expect(await transport.texts.last == boundary)
		#expect((results ? counted.searchNote : tests.searchNote) == nil)
		if results { counted.text = "  shipping  "; await counted.search() }
		else { tests.text = "  shipping  "; await tests.search() }
		#expect(await transport.texts.last == "shipping")
		#expect((results ? counted.searchNote : tests.searchNote) == nil)
	}

	@Test("a refused search or chip can be replaced", arguments: [false, true])
	func refusedQuery(results: Bool) async throws {
		let transport = SearchReplies(results: results)
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: transport)
		let project = server.project("shop", identity: "shop-identity")
		let tests = TestsScreen(project: project)
		let counted = ChangeResults(project: project, change: "pr:1", run: "R-1")
		if results { await counted.load(); #expect(counted.hasRead) } else { await tests.load() }
		await transport.refuse(true)
		if results { counted.text = "refused"; await counted.search() }
		else { tests.text = "refused"; await tests.search() }
		#expect(results ? counted.loading == .failed("Search refused.") : tests.loading == .failed("Search refused."))
		if results { #expect(counted.hasRead); await counted.read() } else { await tests.read() }
		#expect(results ? counted.loading == .failed("Search refused.") : tests.loading == .failed("Search refused."))
		await transport.refuse(false)
		if results { counted.text = "shipping"; await counted.search() }
		else { tests.text = "shipping"; await tests.search() }
		#expect(results ? counted.rows.map(\.name) == ["shipping"] : tests.tests.map(\.name) == ["shipping"])
		#expect(results ? counted.loading == .done : tests.loading == .done)
		if results {
			await transport.refuse(true)
			await counted.show(.unexplained)
			#expect(counted.loading == .failed("Search refused."))
			await transport.refuse(false)
			await counted.show(nil)
			#expect(counted.rows.map(\.name) == ["shipping"])
			#expect(counted.loading == .done)
		}
	}

	@Test("the first refused read has no controls, and even an empty accepted read supplies them")
	func firstFailure() async throws {
		let transport = SearchReplies(results: true)
		await transport.refuse(true)
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: transport)
		let results = ChangeResults(project: server.project("shop", identity: "shop-identity"), change: "pr:1", run: "R-1")
		await results.load()
		#expect(results.loading == .failed("Search refused."))
		#expect(!results.hasRead)
		await transport.refuse(false)
		await results.read()
		#expect(results.loading == .done && results.hasRead)
		#expect(results.rows.map(\.name) == ["All"])
		#expect(results.testTime.map { [$0.ms, $0.timed] } == [4200, 1])
		let empty = ChangeResults(project: server.project("shop", identity: "shop-identity"), change: nil, run: nil)
		await empty.load()
		#expect(empty.loading == .done && empty.hasRead && empty.total == 0)
		#expect(empty.testTime.map { [$0.ms, $0.timed] } == [0, 0])
	}

	@Test("a restored results query is capped before its first read")
	func initialLongQuery() async throws {
		let transport = SearchReplies(results: true)
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: transport)
		let results = ChangeResults(
			project: server.project("shop", identity: "shop-identity"), change: "pr:1", run: "R-1",
			query: .init(text: String(repeating: "🧪", count: 101)))
		await results.load()
		#expect(results.text == String(repeating: "🧪", count: 101))
		#expect(results.searchNote == "Only the beginning of this text is searched.")
		#expect(await transport.texts == [String(repeating: "🧪", count: 100)])
		#expect(results.loading == .done)
	}

	@Test("changing a result chip keeps the chips and search field available")
	func chipWhileReading() async throws {
		let transport = SearchReplies(results: true)
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: transport)
		let results = ChangeResults(project: server.project("shop", identity: "shop-identity"), change: "pr:1", run: "R-1")
		await results.load()
		let chip = Task { await results.show(.unexplained) }
		await transport.untilHeld()
		#expect(results.loading == .reading && results.total == 1)
		#expect(results.standing == .unexplained)
		await transport.release()
		await chip.value
		#expect(results.rows.map(\.name) == ["Unexplained"])
	}
}

private actor SearchReplies: Transport {
	let results: Bool
	private(set) var texts: [String] = []
	private var held: CheckedContinuation<Void, Never>?
	private var refused = false
	func refuse(_ value: Bool) { refused = value }

	init(results: Bool) { self.results = results }
	func untilHeld() async { while held == nil { await Task.yield() } }
	func release() { held?.resume(); held = nil }

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let input = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data())
		let text = input["text"]?.string ?? ""
		let chip = input["state"]?.string == "unexplained"
		texts.append(text)
		if refused {
			return (Data(#"{"ok":false,"error":{"code":"invalid","message":"Search refused."}}"#.utf8),
				HTTPURLResponse(url: request.url!, statusCode: 400, httpVersion: nil, headerFields: nil)!)
		}
		if text == "a" || chip { await withCheckedContinuation { held = $0 } }
		let name = chip ? "Unexplained" : text.isEmpty ? "All" : text
		let row = results
			? #"{"result":1,"test":"T-1","name":"\#(name)","file":null,"case":null,"outcome":"fail","standing":"unexplained","quarantined":false,"question":null,"attempt":1,"durationMs":null,"message":null,"job":"ci","by":"robin","model":null,"steps":null,"build":null}"#
			: #"{"ref":"T-1","name":"\#(name)","file":null,"case":null,"quarantine":null}"#
		let tally = results ? #", "count":1,"tally":{"unexplained":1},"testTime":{"ms":4200,"timed":1}"# : ""
		let body = #"{"ok":true,"result":{"items":[\#(row)],"cursor":null\#(tally)}}"#
		return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
	}

	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		throw URLError(.unsupportedURL)
	}
}
