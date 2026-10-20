import Foundation
import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

/// The real screen APIs, with replies held at the transport boundary until the test releases them.
@Suite("Queue and Runs paging", .timeLimit(.minutes(1)))
@MainActor
struct QueueRunsPagingTests {
	@MainActor private enum Screen {
		case queue(QueueScreen), runs(RunsScreen)

		var titles: [String] {
			switch self {
			case .queue(let screen): screen.questions.map(\.title)
			case .runs(let screen): screen.runs.map(\.name)
			}
		}

		var hasMore: Bool {
			switch self {
			case .queue(let screen): screen.hasMore
			case .runs(let screen): screen.hasMore
			}
		}

		func refresh() async {
			switch self {
			case .queue(let screen): await screen.refresh()
			case .runs(let screen): await screen.refresh()
			}
		}

		func more() async {
			switch self {
			case .queue(let screen): await screen.more()
			case .runs(let screen): await screen.more()
			}
		}

		func filter() async {
			switch self {
			case .queue(let screen): await screen.show(.open, filter: .map)
			case .runs(let screen): await screen.show(RunFilter(kind: .planned))
			}
		}
	}

	private func screen(_ transport: PagingTransport) throws -> Screen {
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: transport)
		let project = server.project("shop", identity: "shop-identity")
		return transport.queue
			? .queue(QueueScreen(project: project, outbox: AnswerOutbox(project: project, store: MemoryAnswerStore())))
			: .runs(RunsScreen(project: project, permission: Project(key: "shop", identity: "shop-identity", name: "Shop"), person: "robin"))
	}

	/// Returns after the operation entered its first suspension, without depending on a clock or a sleep.
	private func start(_ operation: @MainActor @escaping () async -> Void) async -> Task<Void, Never> {
		var entered = false
		let task = Task {
			entered = true
			await operation()
		}
		while !entered { await Task.yield() }
		return task
	}

	@Test("More during refresh keeps the changed row and appends the next page once", arguments: [true, false])
	func refreshThenMore(queue: Bool) async throws {
		let transport = PagingTransport(queue: queue)
		let screen = try screen(transport)
		await screen.refresh()
		#expect(screen.titles == ["Old"] && screen.hasMore)
		await transport.holdNextPage(after: nil, fresh: true)
		let refresh = await start { await screen.refresh() }
		await transport.untilHeld()
		let more = await start { await screen.more() }
		await transport.release()
		await refresh.value
		await more.value
		#expect(screen.titles == ["Fresh", "Fresh second"])
		#expect(!screen.hasMore)
		#expect(await transport.cursors == [nil, nil, "next"])
	}

	@Test("a page read before a filter change cannot append to the filtered list", arguments: [true, false])
	func pageThenFilter(queue: Bool) async throws {
		let transport = PagingTransport(queue: queue)
		let screen = try screen(transport)
		await screen.refresh()
		await transport.holdNextPage(after: "next")
		let more = await start { await screen.more() }
		await transport.untilHeld()
		await screen.filter()
		#expect(screen.titles == ["Filtered"])
		await transport.release()
		await more.value
		#expect(screen.titles == ["Filtered"] && !screen.hasMore)
		#expect(await transport.cursors == [nil, "next", nil])
	}

	@Test("concurrent More calls share one page request", arguments: [true, false])
	func concurrentMore(queue: Bool) async throws {
		let transport = PagingTransport(queue: queue)
		let screen = try screen(transport)
		await screen.refresh()
		await transport.holdNextPage(after: "next")
		let first = await start { await screen.more() }
		await transport.untilHeld()
		let second = await start { await screen.more() }
		await transport.release()
		await first.value
		await second.value
		#expect(screen.titles == ["Old", "Old second"] && !screen.hasMore)
		#expect(await transport.cursors == [nil, "next"])
	}

	@Test("refresh rereads the depth already loaded", arguments: [true, false])
	func loadedDepth(queue: Bool) async throws {
		let transport = PagingTransport(queue: queue)
		let screen = try screen(transport)
		await screen.refresh()
		await screen.more()
		await transport.holdNextPage(after: nil, fresh: true)
		let refresh = await start { await screen.refresh() }
		await transport.untilHeld()
		await transport.release()
		await refresh.value
		#expect(screen.titles == ["Fresh", "Fresh second"] && !screen.hasMore)
		#expect(await transport.cursors == [nil, "next", nil, "next"])
	}
}

private actor PagingTransport: Transport {
	nonisolated let queue: Bool
	private(set) var cursors: [String?] = []
	private var fresh = false
	private var hold: (cursor: String?, armed: Bool)?
	private var held: CheckedContinuation<Void, Never>?
	private var waiters: [CheckedContinuation<Void, Never>] = []

	init(queue: Bool) { self.queue = queue }

	func holdNextPage(after cursor: String?, fresh: Bool = false) {
		hold = (cursor, true)
		self.fresh = fresh
	}

	func untilHeld() async {
		if held != nil { return }
		await withCheckedContinuation { waiters.append($0) }
	}

	func release() {
		held?.resume()
		held = nil
	}

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let input = try #require(try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any])
		let cursor = input["cursor"] as? String
		cursors.append(cursor)
		let filtered = input["kind"] != nil || input["origin"] != nil
		let title = filtered ? "Filtered" : (fresh ? "Fresh" : "Old") + (cursor == nil ? "" : " second")
		let number = filtered ? 9 : cursor == nil ? 1 : 2
		let next = filtered || cursor != nil ? "null" : #""next""#
		let row = queue
			? #"{"q":"Q-\#(number)","kind":"map","title":"\#(title)","producer":"ci","state":"open","evidenceHash":"abc","evidence":{"file":"a.spec.ts","tests":[],"count":0,"facts":[]},"seen":{"count":1,"carried":0},"needs":"one member","answers":["track"],"blocks":[],"about":[],"openedAt":1800000000000,"advice":[],"decision":null,"you":"counts"}"#
			: #"{"ref":"R-\#(number)","name":"\#(title)","origin":"planned","inProgress":0,"workUntil":null,"state":"open","verdict":"pending","reason":"missing","createdAt":1800000000000,"tally":{"missing":1},"accepts":{"self":true}}"#
		let counts = queue ? #""counts":{"open":2,"map":2},"# : ""
		let body = #"{"ok":true,"result":{\#(counts)"items":[\#(row)],"cursor":\#(next)}}"#
		if hold?.armed == true, hold?.cursor == cursor {
			hold?.armed = false
			await withCheckedContinuation {
				held = $0
				for waiter in waiters { waiter.resume() }
				waiters = []
			}
		}
		return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
	}

	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		throw URLError(.unsupportedURL)
	}
}
