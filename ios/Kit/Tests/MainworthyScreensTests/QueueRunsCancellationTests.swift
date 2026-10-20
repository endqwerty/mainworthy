import Foundation
import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("Queue and Runs read cancellation", .timeLimit(.minutes(1)))
@MainActor
struct QueueRunsCancellationTests {
	@Test("canceling a refresh cancels its transport read", arguments: [true, false])
	func cancelRefresh(queue: Bool) async throws {
		let transport = CanceledListTransport()
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: transport)
		let project = server.project("shop", identity: "shop-identity")
		let screen: any ProjectScreen = queue
			? QueueScreen(project: project, outbox: AnswerOutbox(project: project, store: MemoryAnswerStore()))
			: RunsScreen(project: project, permission: Project(key: "shop", identity: "shop-identity", name: "Shop"), person: "robin")
		let refresh = Task { await screen.refresh() }
		await transport.untilHeld()
		refresh.cancel()
		await transport.release()
		await refresh.value
		#expect(await transport.canceled == true)
	}
}

private actor CanceledListTransport: Transport {
	private var held: CheckedContinuation<Void, Never>?
	private(set) var canceled = false

	func untilHeld() async {
		while held == nil { await Task.yield() }
	}

	func release() { held?.resume(); held = nil }

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		await withCheckedContinuation { held = $0 }
		canceled = Task.isCancelled
		throw URLError(.cancelled)
	}

	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		throw URLError(.unsupportedURL)
	}
}
