import Foundation
import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

/// Holds the reply to a `find` of runs whose input names `match`, until released. Every other request goes through.
actor HeldRunList: Transport {
	let match: String
	private let wrapped = URLSessionTransport()
	private let asked = AsyncStream.makeStream(of: Void.self)
	private let released = AsyncStream.makeStream(of: Void.self)
	init(match: String) { self.match = match }
	func wasAsked() async { for await _ in asked.stream { break } }
	func release() { released.continuation.yield() }
	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let input = String(decoding: request.httpBody ?? Data(), as: UTF8.self)
		guard request.url?.path.hasSuffix("/find") == true, input.contains("runs"), input.contains(match) else {
			return try await wrapped.send(request)
		}
		let reply = try await wrapped.send(request)
		asked.continuation.yield()
		for await _ in released.stream { break }
		return reply
	}
	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		try await wrapped.lines(request)
	}
}

// The findings of the independent review of the run history (issues #430 and #431), each held to the server.
@Suite("Run history against the server", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
@MainActor
struct RunHistoryTests {
	func report(_ server: Server, in project: String, commit: String, pr: Int) async throws {
		let _: JSONValue = try await server.write(
			"report", in: project,
			[
				"target": [
					"commit": .string(commit), "repo": "acme/shop", "branch": .string("review-\(pr)"), "pr": .number(Double(pr)),
				],
				"job": "review", "results": [["test": ["key": "review-pass"], "outcome": "pass"]],
			])
	}

	@Test("a change opened while the last one's runs are read keeps its own results")
	func changingChangeWhileRunsWait() async throws {
		let transport = HeldRunList(match: "pr:482")
		let server = Live.server(transport: transport)
		_ = try await server.signIn(Live.owner)
		let client = try await server.project(try await Live.project())
		try await report(server, in: client.key, commit: String(repeating: "6", count: 40), pr: 483)
		let screen = ChangesScreen(project: client)
		let old = Task { await screen.open("pr:482") }
		await transport.wasAsked()
		await screen.open("pr:483")
		await transport.release()
		await old.value
		#expect(screen.detail?.change.key == "pr:483" && screen.results?.change == "pr:483")
		#expect(screen.runs.allSatisfy { if case .change(let change) = $0.kind { change?.key == "pr:483" } else { false } })
	}

	@Test("a list read for an earlier filter does not replace the list of the newer one")
	func lateListCannotReplaceNewFilter() async throws {
		let transport = HeldRunList(match: "planned")
		let server = Live.server(transport: transport)
		_ = try await server.signIn(Live.owner)
		let client = try await server.project(try await Live.project())
		let screen = RunsScreen(
			project: client, permission: Project(key: client.key, identity: client.identity, name: client.key, can: ["read", "plan"]),
			person: Live.ownerName)
		let old = Task { await screen.show(RunFilter(kind: .planned)) }
		await transport.wasAsked()
		await screen.show(RunFilter(kind: .change))
		await transport.release()
		await old.value
		#expect(screen.filter.kind == .change && !screen.runs.isEmpty && screen.runs.allSatisfy { !$0.isPlanned })
	}

	@Test("a run planned while a filter hides planned runs is listed, so it opens")
	func planUnderChangeFilter() async throws {
		let server = Live.server()
		_ = try await server.signIn(Live.owner)
		let client = try await server.project(try await Live.project())
		let screen = RunsScreen(
			project: client, permission: Project(key: client.key, identity: client.identity, name: client.key, can: ["read", "produce", "plan"]),
			person: Live.ownerName)
		await screen.show(RunFilter(kind: .change))
		let run = try #require(await screen.plan(name: "Planned under Change", selection: .tag("regression")))
		#expect(screen.filter == RunFilter() && screen.runs.first?.ref == run.ref)
	}

	@Test("a change with more runs than a page reads the rest, and keeps them on refresh")
	func moreThanAPage() async throws {
		let server = Live.server()
		_ = try await server.signIn(Live.owner)
		let client = try await server.project(try await Live.project())
		for number in 0..<2 { try await report(server, in: client.key, commit: String(format: "%040x", 7000 + number), pr: 482) }
		let screen = ChangesScreen(project: client, runsPerPage: 2)
		await screen.refresh()
		await screen.open("pr:482")
		#expect(screen.runs.count == 2 && screen.hasMoreRuns)
		await screen.moreRuns()
		#expect(screen.runs.count == 3 && !screen.hasMoreRuns)
		await screen.refresh()
		#expect(screen.runs.count == 3 && !screen.hasMoreRuns)
	}
}
