import Foundation
import MainworthyClient
import TestSupport
import Testing
@testable import MainworthyScreens

@Suite("Token administration against the server", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
@MainActor
struct TokensScreenTests {
	private func owner(transport: any Transport = URLSessionTransport()) async throws -> Server {
		let server = Server(instance: Live.instance, secrets: MemoryStore(), transport: transport)
		_ = try await server.signIn(Live.owner)
		return server
	}

	private func make(_ server: Server) async throws -> AccessToken {
		let actor = "token-\(UUID().uuidString.lowercased())"
		let _: JSONValue = try await server.write("admin", in: nil, [
			"do": "token.create", "actor": .string(actor), "kind": "ci", "can": ["read"], "label": "Pipeline check",
		])
		return try #require(try await server.tokens().first { $0.actor == actor })
	}

	@Test("the list identifies a token and revoking its confirmed row reports definite outcomes")
	func revoke() async throws {
		let server = try await owner()
		let token = try await make(server)
		#expect(token.label == "Pipeline check" && token.kind == "ci" && token.createdBy == Live.ownerName)
		#expect(token.createdAt.timeIntervalSince1970 > 0 && token.lastUsedAt == nil && token.lastUsedFrom == nil)
		#expect(token.state == .active && token.expiresAt == nil)
		let screen = TokensScreen(server: server)
		await screen.refresh()
		#expect(screen.loading == .done && screen.tokens.contains(token))
		await screen.revoke(token)
		#expect(screen.action == .revoked(token))
		#expect(screen.tokens.first { $0.id == token.id }?.state == .revoked)
		await screen.revoke(token)
		#expect(screen.action == .alreadyRevoked(token))
	}

	@Test("only human instance admins see Tokens, and the server refuses other sessions")
	func permissions() async throws {
		let server = try await owner()
		#expect(try await server.account().mayAdministerTokens)
		let name = "viewer-\(UUID().uuidString.lowercased())"
		let key = try await Live.project()
		let invitation: JSONValue = try await server.write("invitation", in: nil, [
			"do": "create", "name": .string(name), "can": ["read", "admin"], "project": .string(key),
		])
		let code = try #require(invitation["code"]?.string)
		var join = URLRequest(url: Live.instance.url.appending(path: "/api/login"))
		join.httpMethod = "POST"
		join.setValue("application/json", forHTTPHeaderField: "Content-Type")
		join.httpBody = try JSONEncoder().encode(JSONValue.object(["invitation": .string(code), "password": "Viewer test password"]))
		let (_, joined) = try await URLSessionTransport().send(join)
		#expect(joined.statusCode == 200)
		let ordinary = Live.server()
		_ = try await ordinary.signIn(.password(name: name, password: "Viewer test password"))
		let account = try await ordinary.account()
		#expect(!account.mayAdministerTokens && account.projects.first { $0.key == key }?.may(.admin) == true)
		let projectAdmin = Account(name: "project-admin", projects: [Project(key: "shop", identity: "shop-identity", name: "Shop", can: ["read", "admin"])])
		#expect(!projectAdmin.mayAdministerTokens)
		let token = try await make(server)
		let screen = TokensScreen(server: ordinary)
		await screen.revoke(token)
		guard case .refused(let selected, let why) = screen.action else { Issue.record("missing refusal"); return }
		#expect(selected == token && why.contains("admin"))
		#expect(try await server.tokens().first { $0.id == token.id }?.state == .active)
	}

	@Test("a token used through the API reports when and where it was used")
	func usage() async throws {
		let server = try await owner()
		let actor = "used-\(UUID().uuidString.lowercased())"
		let made: JSONValue = try await server.write("admin", in: nil, [
			"do": "token.create", "actor": .string(actor), "kind": "agent", "label": "Review check", "can": ["read"],
			"expires": "1h",
		])
		var use = URLRequest(url: Live.instance.url.appending(path: "/api/session"))
		use.setValue("Bearer \(try #require(made["token"]?.string))", forHTTPHeaderField: "Authorization")
		let (_, used) = try await URLSessionTransport().send(use)
		#expect(used.statusCode == 200)
		let token = try #require(try await server.tokens().first { $0.actor == actor })
		#expect(token.label == "Review check" && token.kind == "agent" && token.state == .active)
		#expect(token.lastUsedAt != nil && token.lastUsedFrom == "127.0.0.1" && token.expiresAt != nil)
	}

	@Test("a reply lost after commit stays unknown and replays one saved command, across refreshes")
	func recover() async throws {
		let transport = LosingReply()
		let server = try await owner(transport: transport)
		let token = try await make(server)
		let screen = TokensScreen(server: server)
		await screen.refresh()
		await transport.lose(true)
		await screen.revoke(token)
		guard case .unknown(let selected, _) = screen.action else { Issue.record("lost reply was not unknown"); return }
		#expect(selected == token && !screen.mayRevoke)
		await screen.refresh()
		#expect(screen.tokens.first { $0.id == token.id }?.state == .revoked)
		await screen.revoke(try await make(server))
		await transport.lose(false)
		await screen.checkAgain()
		#expect(screen.action == .revoked(token) && screen.mayRevoke)
		let sent = await transport.revocations
		#expect(sent.count >= 2 && Set(sent).count == 1)
		print("TOKEN_RECOVERY state=revoked identicalPayloads=\(Set(sent).count) requests=\(sent.count)")
	}

	@Test("a request lost before reaching the server recovers with the saved command")
	func lostBeforeSend() async throws {
		let transport = LosingReply()
		let server = try await owner(transport: transport)
		let token = try await make(server)
		let screen = TokensScreen(server: server)
		await transport.lose(true, beforeSend: true)
		await screen.revoke(token)
		guard case .unknown = screen.action else { Issue.record("missing unknown outcome"); return }
		#expect(screen.tokens.first { $0.id == token.id }?.state == .active)
		await transport.lose(false)
		await screen.checkAgain()
		#expect(screen.action == .revoked(token))
		#expect(screen.tokens.first { $0.id == token.id }?.state == .revoked)
		#expect(Set(await transport.revocations).count == 1)
	}

	@Test("a refused recovery keeps the earlier unknown outcome until its reply is recovered")
	func refusedRecovery() async throws {
		let transport = LosingReply()
		let server = try await owner(transport: transport)
		let token = try await make(server)
		let screen = TokensScreen(server: server)
		await transport.lose(true)
		await screen.revoke(token)
		await transport.lose(false)
		await transport.refuse(true)
		await screen.checkAgain()
		guard case .unknown(let selected, let why) = screen.action else { Issue.record("recovery refusal hid uncertainty"); return }
		#expect(selected == token && why == "Admin permission was removed" && !screen.mayRevoke)
		await transport.refuse(false)
		await screen.checkAgain()
		#expect(screen.action == .revoked(token) && screen.mayRevoke)
	}

	@Test("a list read before a revocation cannot replace its refreshed revoked state")
	func staleList() async throws {
		let transport = DelayedList()
		let server = try await owner(transport: transport)
		let token = try await make(server)
		let screen = TokensScreen(server: server)
		await transport.arm()
		let older = Task { await screen.refresh() }
		while !(await transport.paused) { await Task.yield() }
		await screen.revoke(token)
		await transport.resume()
		await older.value
		#expect(screen.action == .revoked(token))
		#expect(screen.tokens.first { $0.id == token.id }?.state == .revoked)
	}

	@Test("the instance token screen survives project switches")
	func workspace() async throws {
		let server = try await owner()
		let account = try await server.account()
		let workspace = Workspace(server: server, account: account,
			remembered: Remembered(UserDefaults(suiteName: UUID().uuidString)!), onSignedOut: {})
		let screen = workspace.tokens
		workspace.open(Project(key: "other", identity: "other-identity", name: "Other"))
		#expect(workspace.tokens === screen)
	}

	actor LosingReply: Transport {
		let live = URLSessionTransport()
		private var losing = false
		private var beforeSend = false
		private var refusing = false
		private(set) var revocations: [JSONValue] = []
		func lose(_ value: Bool, beforeSend: Bool = false) { losing = value; self.beforeSend = beforeSend }
		func refuse(_ value: Bool) { refusing = value }
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			let body = try? JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data())
			let revoking = body?["do"]?.string == "token.revoke"
			if revoking, let body { revocations.append(body) }
			if revoking && refusing {
				return (Data(#"{"ok":false,"error":{"code":"forbidden","message":"admin permission was removed"}}"#.utf8),
					HTTPURLResponse(url: request.url!, statusCode: 403, httpVersion: nil, headerFields: nil)!)
			}
			if revoking && losing && beforeSend { throw URLError(.networkConnectionLost) }
			let reply = try await live.send(request)
			if revoking && losing { throw URLError(.networkConnectionLost) }
			return reply
		}
		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			try await live.lines(request)
		}
	}

	actor DelayedList: Transport {
		let live = URLSessionTransport()
		private var armed = false
		private(set) var paused = false
		private var release: CheckedContinuation<Void, Never>?
		func arm() { armed = true }
		func resume() { release?.resume(); release = nil }
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			let reply = try await live.send(request)
			let body = try? JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data())
			if armed && body?["do"]?.string == "token.list" {
				armed = false
				paused = true
				await withCheckedContinuation { release = $0 }
			}
			return reply
		}
		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			try await live.lines(request)
		}
	}
}
