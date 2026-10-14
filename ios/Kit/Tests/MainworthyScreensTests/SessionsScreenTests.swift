import Foundation
import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("The sessions screen", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
@MainActor
struct SessionsScreenTests {
	@Test("ending another session refreshes the list, and ending this device calls sign out")
	func end() async throws {
		let server = try await Live.signedIn()
		var signedOut = false
		let screen = SessionsScreen(server: server) { await server.signOut(); signedOut = true }
		let other = try await Live.signedIn()
		let theirs = try #require(try await other.sessions().first { $0.current })
		await screen.refresh()
		#expect(screen.loading == .done)
		await screen.end(try #require(screen.sessions.first { $0.id == theirs.id }))
		#expect(!screen.sessions.contains { $0.id == theirs.id } && !signedOut)
		#expect(screen.notice == "Session ended." && screen.busy.isEmpty)
		let mine = try #require(screen.sessions.first { $0.current })
		await screen.end(mine)
		#expect(signedOut)
	}

	@Test("sessions survives project switches, and its sign out clears the workspace's remembered proof")
	func workspaceOwnsSessions() async throws {
		let secrets = MemoryStore()
		let server = Live.server(secrets: secrets)
		let account = try await server.signIn(.password(name: Live.name, password: Live.password))
		var signedOut = false
		let workspace = Workspace(
			server: server, account: account, remembered: Remembered(UserDefaults(suiteName: UUID().uuidString)!),
			onSignedOut: { signedOut = true }
		)
		let sessions = workspace.sessions
		workspace.open(Project(key: try await Live.project(), name: "Other"))
		#expect(workspace.sessions === sessions)
		await sessions.refresh()
		await sessions.end(try #require(sessions.sessions.first { $0.current }))
		#expect(signedOut && secrets.load() == nil)
	}
}

@Suite("Sessions reads that fail")
@MainActor
struct SessionsReadTests {
	@Test("an unreachable instance shows the reason in place of the list")
	func failure() async throws {
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: QueueScreenFailureTests.Down()
		)
		let screen = SessionsScreen(server: server) {}
		await screen.refresh()
		guard case .failed(let why) = screen.loading else { Issue.record("the failed read was not shown"); return }
		#expect(why.hasPrefix("The server could not be reached."))
		#expect(screen.sessions.isEmpty)
	}
}

@Suite("Session endings the server does not take")
@MainActor
struct SessionsRefusalTests {
	struct Refusal: Transport {
		let refuses: Bool

		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			let ending = String(decoding: request.httpBody ?? Data(), as: UTF8.self).contains(#""do":"end""#)
			let list = """
				{"ok":true,"result":[{"id":7,"openedWith":"password","label":"password",
				"createdAt":1,"lastUsedAt":2,"expiresAt":3,"current":false}]}
				"""
			let declined = #"{"ok":true,"result":{"ended":false,"current":false}}"#
			let refused = #"{"ok":false,"error":{"code":"forbidden","message":"only your own session can be ended"}}"#
			let body = ending ? (refuses ? refused : declined) : list
			let response = HTTPURLResponse(
				url: request.url!, statusCode: ending && refuses ? 403 : 200, httpVersion: nil, headerFields: nil
			)!
			return (Data(body.utf8), response)
		}

		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			throw URLError(.unsupportedURL)
		}
	}

	@Test("a refusal is shown, and a 200 with ended false does not claim success", arguments: [true, false])
	func refused(_ refuses: Bool) async throws {
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: Refusal(refuses: refuses)
		)
		var signedOut = false
		let screen = SessionsScreen(server: server) { signedOut = true }
		await screen.refresh()
		await screen.end(try #require(screen.sessions.first))
		#expect(screen.notice == (refuses ? "Only your own session can be ended" : "The server did not end this session."))
		#expect(screen.sessions.count == 1 && !signedOut && screen.busy.isEmpty)
	}
}
