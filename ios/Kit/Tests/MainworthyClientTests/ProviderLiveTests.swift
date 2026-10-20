import Foundation
import Testing
import TestSupport
@testable import MainworthyClient

@Suite(.enabled(if: Live.isRunning))
struct ProviderLiveTests {
	@Test func providerOpensAnIndependentSessionAndKeepsOnlyItsCookie() async throws {
		let store = MemoryStore()
		let server = Live.server(secrets: store)
		#expect(try await server.providerName() == "Example ID")
		let attempt = try await server.beginProviderSignIn()
		let callback = try await callback(for: attempt)
		let account = try await server.finishProviderSignIn(attempt, callback: callback)
		#expect(account.name == Live.name)
		#expect(server.cookieHeader?.hasPrefix("mainworthy_sid=") == true)
		let saved = try #require(store.load())
		let text = String(decoding: saved, as: UTF8.self)
		#expect(!text.contains(attempt.proof.verifier))
		#expect(!text.contains(attempt.proof.state))
		let restored = try #require(Server.kept(in: store))
		#expect(try await restored.account().name == Live.name)
		await #expect(throws: ClientError.self) { try await server.finishProviderSignIn(attempt, callback: callback) }
		await server.signOut()
	}

	@Test func callbacksFromAnotherRequestOrAnotherAddressAreRejected() async throws {
		let server = Live.server()
		let first = try await server.beginProviderSignIn()
		let second = try await server.beginProviderSignIn()
		let callback = try await callback(for: first)
		#expect(throws: ClientError.self) { try second.code(from: callback) }
		let wrongAddress = try #require(URL(string: callback.absoluteString.replacingOccurrences(of: "/oidc?", with: "/elsewhere?")))
		#expect(throws: ClientError.self) { try first.code(from: wrongAddress) }
		#expect(server.cookieHeader == nil)
		#expect(try await server.finishProviderSignIn(first, callback: callback).name == Live.name)
		await server.signOut()
	}

	private func callback(for attempt: ProviderSignIn) async throws -> URL {
		let transport = URLSessionTransport()
		let (_, authorized) = try await transport.send(URLRequest(url: attempt.url))
		let back = try #require(authorized.value(forHTTPHeaderField: "Location").flatMap(URL.init(string:)))
		let (_, done) = try await transport.send(URLRequest(url: back))
		#expect(done.statusCode == 302)
		#expect(done.value(forHTTPHeaderField: "Set-Cookie") == nil)
		return try #require(done.value(forHTTPHeaderField: "Location").flatMap(URL.init(string:)))
	}
}
