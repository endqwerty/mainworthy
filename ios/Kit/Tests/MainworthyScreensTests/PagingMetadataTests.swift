import Foundation
import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("Queue paging metadata")
@MainActor
struct PagingMetadataTests {
	@Test("queue counts follow the latest page, including a refresh to loaded depth")
	func counts() async throws {
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: QueueCountPages())
		let project = server.project("shop", identity: "shop-identity")
		let screen = QueueScreen(project: project, outbox: AnswerOutbox(project: project, store: MemoryAnswerStore()))
		await screen.show(.open, filter: .map)
		#expect(screen.questions.map(\.ref) == ["Q-1"])
		#expect(screen.counts.open == 7 && screen.counts.open(of: .map) == 5)
		await screen.more()
		#expect(screen.questions.map(\.ref) == ["Q-1", "Q-2"])
		#expect(screen.counts.open == 6 && screen.counts.open(of: .map) == 4)
		await screen.refresh()
		#expect(screen.questions.map(\.ref) == ["Q-1", "Q-2"] && !screen.hasMore)
		#expect(screen.counts.open == 6 && screen.counts.open(of: .map) == 4)
	}
}

private struct QueueCountPages: Transport {
	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let input = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data())
		let second = input["cursor"]?.string != nil
		let number = second ? 2 : 1
		let cursor = second ? "null" : #""next""#
		let row = #"{"q":"Q-\#(number)","kind":"map","title":"Test \#(number)","producer":"ci","state":"open","evidenceHash":"abc","evidence":{"file":"a.spec.ts","tests":[],"count":0,"facts":[]},"seen":{"count":1,"carried":0},"needs":"one member","answers":["track"],"blocks":[],"about":[],"openedAt":1800000000000,"advice":[],"decision":null,"you":"counts"}"#
		let body = #"{"ok":true,"result":{"counts":{"open":\#(second ? 6 : 7),"map":\#(second ? 4 : 5)},"items":[\#(row)],"cursor":\#(cursor)}}"#
		return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
	}

	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		throw URLError(.unsupportedURL)
	}
}

@Suite("A planned run survives a failed list read", .enabled(if: Live.isRunning, "live server"))
@MainActor
struct PlannedRunListTests {
	@Test("a separately read plan resets an excluding filter and appears once when the list cannot be read")
	func includePlannedRun() async throws {
		let key = try await Live.project()
		let server = Server(instance: Live.instance, secrets: MemoryStore(), transport: FailedRunList())
		_ = try await server.signIn(.password(name: Live.name, password: Live.password))
		let project = try await server.project(key)
		let screen = RunsScreen(
			project: project, permission: Project(key: key, identity: project.identity, name: key, can: ["read", "plan"]),
			person: Live.name)
		await screen.show(RunFilter(kind: .change))
		let run = try #require(await screen.plan(name: "Plan kept without a list", selection: .all))
		#expect(screen.filter == RunFilter() && screen.loading == .done)
		#expect(screen.runs.map(\.ref) == [run.ref])
		#expect(screen.runs.map(\.name) == ["Plan kept without a list"])
		#expect(screen.planSubmission == nil && screen.savedPlan == nil)
		#expect(screen.notice == "\(run.ref) planned with 6 slots; 0 already filled.")
	}
}

private struct FailedRunList: Transport {
	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		if request.url?.lastPathComponent == "find",
			let data = request.httpBody, try JSONDecoder().decode(JSONValue.self, from: data)["in"]?.string == "runs"
		{
			return (Data("unreadable list".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
		}
		return try await URLSessionTransport().send(request)
	}

	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		throw URLError(.unsupportedURL)
	}
}
