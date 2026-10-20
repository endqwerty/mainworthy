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
		#expect(results ? counted.loading == .done : tests.loading == .done)
		older.cancel()
		if results { counted.text = "ab" } else { tests.text = "ab" }
		// The same initial-loading guards used by the two SwiftUI text tasks.
		let newer = Task {
			if results {
				guard counted.loading == .done else { return }
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

	@Test("changing a result chip keeps the chips and search field available")
	func chipWhileReading() async throws {
		let transport = SearchReplies(results: true)
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: transport)
		let results = ChangeResults(project: server.project("shop", identity: "shop-identity"), change: "pr:1", run: "R-1")
		await results.load()
		let chip = Task { await results.show(.unexplained) }
		await transport.untilHeld()
		#expect(results.loading == .done && results.total == 1)
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

	init(results: Bool) { self.results = results }
	func untilHeld() async { while held == nil { await Task.yield() } }
	func release() { held?.resume(); held = nil }

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let input = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data())
		let text = input["text"]?.string ?? ""
		let chip = input["state"]?.string == "unexplained"
		texts.append(text)
		if text == "a" || chip { await withCheckedContinuation { held = $0 } }
		let name = chip ? "Unexplained" : text.isEmpty ? "All" : text
		let row = results
			? #"{"result":1,"test":"T-1","name":"\#(name)","file":null,"case":null,"outcome":"fail","standing":"unexplained","quarantined":false,"question":null,"attempt":1,"durationMs":null,"message":null,"job":"ci","by":"robin","model":null,"steps":null,"build":null}"#
			: #"{"ref":"T-1","name":"\#(name)","file":null,"case":null,"quarantine":null}"#
		let tally = results ? #", "count":1,"tally":{"unexplained":1}"# : ""
		let body = #"{"ok":true,"result":{"items":[\#(row)],"cursor":null\#(tally)}}"#
		return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
	}

	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		throw URLError(.unsupportedURL)
	}
}
