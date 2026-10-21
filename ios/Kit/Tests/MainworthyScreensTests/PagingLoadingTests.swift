import Foundation
import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("A new list query has not been read", .timeLimit(.minutes(1)))
@MainActor
struct PagingLoadingTests {
	enum Selection: CaseIterable, Sendable {
		case queueKind, queueDecided, queueOpen, runsKind, runsState, runsAll

		var queue: Bool {
			switch self {
			case .queueKind, .queueDecided, .queueOpen: true
			case .runsKind, .runsState, .runsAll: false
			}
		}
	}

	@Test("a changed filter waits for its first reply and offers retry if it fails", arguments: Selection.allCases)
	func newQuery(selection: Selection) async throws {
		let transport = LoadingReplies(queue: selection.queue)
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: transport)
		let project = server.project("shop", identity: "shop-identity")
		let queue = QueueScreen(project: project, outbox: AnswerOutbox(project: project, store: MemoryAnswerStore()))
		let runs = RunsScreen(
			project: project, permission: Project(key: "shop", identity: "shop-identity", name: "Shop"), person: "robin")
		let loading = { selection.queue ? queue.loading : runs.loading }
		let rowCount = { selection.queue ? queue.questions.count : runs.runs.count }
		if selection.queue { await queue.refresh() } else { await runs.refresh() }
		if selection == .queueOpen { await queue.show(.decided, filter: nil) }
		if selection == .runsAll { await runs.show(RunFilter(kind: .planned)) }
		#expect(loading() == .done && rowCount() == 0)

		await transport.holdFailure()
		let changed = Task {
			switch selection {
			case .queueKind: await queue.show(.open, filter: .map)
			case .queueDecided: await queue.show(.decided, filter: nil)
			case .queueOpen: await queue.show(.open, filter: nil)
			case .runsKind: await runs.show(RunFilter(kind: .planned))
			case .runsState: await runs.show(RunFilter(state: .open))
			case .runsAll: await runs.show(RunFilter())
			}
		}
		await transport.untilHeld()
		// Every empty-state sentence is conditional on done in the views.
		#expect(loading() == .reading)
		#expect(rowCount() == 0)
		await transport.release()
		await changed.value
		let why = "The reply could not be read. Install a newer build of the app: the server may be ahead of it."
		// The views' existing could-not-read state and Try again use this case.
		#expect(loading() == .failed(why))
		#expect(rowCount() == 0)

		if selection.queue { await queue.refresh() } else { await runs.refresh() }
		#expect(loading() == .done && rowCount() == 0)
	}
}

private actor LoadingReplies: Transport {
	let queue: Bool
	private var fails = false
	private var held: CheckedContinuation<Void, Never>?

	init(queue: Bool) { self.queue = queue }
	func holdFailure() { fails = true }
	func untilHeld() async { while held == nil { await Task.yield() } }
	func release() { held?.resume(); held = nil }

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let fail = fails
		if fail {
			fails = false
			await withCheckedContinuation { held = $0 }
		}
		let counts = queue ? #""counts":{"open":0},"# : ""
		let body = fail ? "unreadable list" : #"{"ok":true,"result":{\#(counts)"items":[],"cursor":null}}"#
		return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
	}

	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		throw URLError(.unsupportedURL)
	}
}
