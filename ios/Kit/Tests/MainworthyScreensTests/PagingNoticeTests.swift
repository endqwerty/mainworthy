import Foundation
import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("List and action notices replace each other", .enabled(if: Live.isRunning, "live server"))
@MainActor
struct PagingNoticeTests {
	@Test("a queue error permanently replaces Undo, and a later answer replaces the error")
	func queueNotice() async throws {
		let transport = NoticeListTransport()
		let project = try await Live.signedIn(transport: transport).project(try await Live.project())
		let screen = QueueScreen(project: project, outbox: AnswerOutbox(project: project, store: MemoryAnswerStore()))
		await screen.refresh()
		let failure = try #require(screen.questions.first { $0.kind == .failure })
		#expect(await screen.answer(failure, with: try #require(failure.choices.first { $0.answer == "flaky" })))
		#expect(screen.notice?.text == "\(failure.ref): Flaky." && screen.notice?.undoes != nil)
		await transport.failLists(true)
		await screen.refresh()
		let problem = try #require(screen.notice)
		#expect(problem.text == "The reply could not be read. Install a newer build of the app: the server may be ahead of it.")
		#expect(problem.isProblem && problem.undoes == nil)
		await transport.failLists(false)
		await screen.refresh()
		#expect(screen.notice == problem)
		let finding = try #require(screen.questions.first { $0.kind == .finding })
		#expect(await screen.answer(finding, with: try #require(finding.choices.first { $0.answer == "defer" })))
		#expect(screen.notice?.text == "\(finding.ref): Defer." && screen.notice?.undoes != nil)
	}

	@Test("a run-list error permanently replaces a plan notice, and a later plan replaces the error")
	func runsNotice() async throws {
		let transport = NoticeListTransport()
		let project = try await Live.signedIn(transport: transport).project(try await Live.project())
		let screen = RunsScreen(
			project: project, permission: Project(key: project.key, identity: project.identity, name: project.key, can: ["read", "plan"]),
			person: Live.name)
		let first = try #require(await screen.plan(name: "First plan", selection: .all))
		#expect(screen.notice == "\(first.ref) planned with 6 slots; 0 already filled.")
		await transport.failLists(true)
		await screen.refresh()
		let problem = try #require(screen.notice)
		#expect(problem == "The reply could not be read. Install a newer build of the app: the server may be ahead of it.")
		await transport.failLists(false)
		await screen.refresh()
		#expect(screen.notice == problem)
		await transport.failLists(true)
		let second = try #require(await screen.plan(name: "Later plan", selection: .all))
		#expect(screen.notice == "\(second.ref) planned with 6 slots; 0 already filled.")
	}
}

private actor NoticeListTransport: Transport {
	private var fails = false
	func failLists(_ fails: Bool) { self.fails = fails }

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let input = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data("{}".utf8))
		if fails && (request.url?.lastPathComponent == "inbox"
			|| (request.url?.lastPathComponent == "find" && input["in"]?.string == "runs"))
		{
			return (Data("unreadable list".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
		}
		return try await URLSessionTransport().send(request)
	}

	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		throw URLError(.unsupportedURL)
	}
}
