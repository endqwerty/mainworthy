import Foundation
import MainworthyClient
import Synchronization
import Testing

@testable import MainworthyScreens

private let sessionCookie = String(repeating: "s", count: 43)
private let ceremonyCookie = String(repeating: "c", count: 43)
private let challenge = Data([0, 1, 2, 253, 254, 255])
private let challengeReply = #"{"ok":true,"result":{"passkey":{"rpId":"mainworthy.example","challenge":"AAEC_f7_","userVerification":"required"}}}"#
private let accountReply = #"{"ok":true,"result":{"actor":"robin","actorId":7,"kind":"human","can":[],"mode":"server","via":"cookie","session":2,"owner":false,"version":"0.1.0","projects":[]}}"#

private final class PasskeyTransport: Transport {
	struct Reply { let body: String; var status = 200; var headers: [String: String] = [:] }
	private let state: Mutex<(requests: [URLRequest], replies: [Reply])>
	init(_ replies: [Reply]) { state = Mutex(([], replies)) }
	var requests: [URLRequest] { state.withLock { $0.requests } }
	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let reply = state.withLock { state -> Reply in
			state.requests.append(request)
			return state.replies.removeFirst()
		}
		return (Data(reply.body.utf8), HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: reply.headers)!)
	}
	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) { throw URLError(.unsupportedURL) }
}

@MainActor
private final class FakePasskey: PasskeyAuthorizing {
	var asked: PasskeyRequest?
	var error: (any Error)?
	func authorize(_ request: PasskeyRequest) async throws -> PasskeyAssertion {
		asked = request
		if let error { throw error }
		return PasskeyAssertion(credentialID: Data([251, 255]), clientDataJSON: Data([1]), authenticatorData: Data([2]), signature: Data([3]), userID: Data([4]))
	}
}

@Suite("Native passkey sign-in") @MainActor
struct PasskeySignInTests {
	private let instance = Instance(address: "https://mainworthy.example:8443")!
	private func start(_ body: String = challengeReply, cookie: Bool = true, prefix: String = "__Host-") -> PasskeyTransport.Reply {
		.init(body: body, headers: cookie ? ["Set-Cookie": "\(prefix)mainworthy_ceremony=\(ceremonyCookie); Path=/; Secure; HttpOnly"] : [:])
	}
	private var success: [PasskeyTransport.Reply] {
		[.init(body: #"{"ok":true,"result":{"signedIn":true}}"#, headers: ["Set-Cookie": "__Host-mainworthy_sid=\(sessionCookie); Path=/; Secure; HttpOnly"]), .init(body: accountReply)]
	}
	private func form(_ transport: PasskeyTransport, store: MemoryStore, signed: @escaping (Account) -> Void = { _ in }) -> SignInForm {
		SignInForm(instance: instance, notice: nil, connect: { Server(instance: $0, secrets: store, transport: transport) }, onSignedIn: { _, account in signed(account) })
	}

	@Test("the selected instance's challenge goes to authorization and its reply opens the usual persisted session", arguments: ["__Host-", ""])
	func signsIn(_ prefix: String) async throws {
		let transport = PasskeyTransport([start(prefix: prefix)] + success)
		let store = MemoryStore()
		var name = ""
		let form = form(transport, store: store) { name = $0.name }
		let authorization = FakePasskey()
		form.password = "fallback"
		await form.signInWithPasskey(using: authorization)
		#expect(name == "robin" && !form.isWorking && form.password.isEmpty)
		#expect(authorization.asked?.relyingParty == "mainworthy.example")
		#expect(authorization.asked?.challenge == challenge)
		#expect(transport.requests.map { $0.url!.absoluteString } == ["https://mainworthy.example:8443/api/login/challenge", "https://mainworthy.example:8443/api/login", "https://mainworthy.example:8443/api/session"])
		try #require(transport.requests.count == 3)
		let bodies = try transport.requests.prefix(2).map { try JSONDecoder().decode(JSONValue.self, from: $0.httpBody!) }
		#expect(bodies == [["native": true], ["passkey": ["id": "-_8", "clientDataJSON": "AQ", "authenticatorData": "Ag", "signature": "Aw", "userHandle": "BA"]]])
		#expect(transport.requests[1].value(forHTTPHeaderField: "Cookie") == "\(prefix)mainworthy_ceremony=\(ceremonyCookie)")
		#expect(transport.requests[2].value(forHTTPHeaderField: "Cookie") == "__Host-mainworthy_sid=\(sessionCookie)")
		let kept = String(decoding: try #require(store.load()), as: UTF8.self)
		#expect(kept.contains(sessionCookie) && !kept.contains(ceremonyCookie) && !kept.contains("fallback"))
	}

	@Test("cancel and unavailable credentials preserve the password fallback", arguments: [false, true])
	func unavailable(_ cancel: Bool) async {
		let transport = PasskeyTransport([start()] + success)
		let store = MemoryStore()
		var name = ""
		let form = form(transport, store: store) { name = $0.name }
		let authorization = FakePasskey()
		authorization.error = cancel ? CancellationError() : PasskeyAuthorizationError.unavailable
		form.name = "robin"; form.password = "fallback"
		await form.signInWithPasskey(using: authorization)
		#expect(form.canSubmit && form.name == "robin" && form.password == "fallback")
		#expect(form.notice == (cancel ? nil : "No passkey was available for this instance. Try again or sign in with your password."))
		#expect(store.load() == nil && name.isEmpty && transport.requests.count == 1)
		await form.submit()
		#expect(name == "robin")
	}

	@Test("a refused or stale assertion can retry with a fresh ceremony and keeps password entry")
	func refused() async {
		let refused = PasskeyTransport.Reply(body: #"{"ok":false,"error":{"code":"unauthenticated","message":"that did not sign you in"}}"#, status: 401)
		let transport = PasskeyTransport([start(), refused, start()] + success)
		let store = MemoryStore()
		var name = ""
		let form = form(transport, store: store) { name = $0.name }
		form.name = "robin"; form.password = "fallback"
		await form.signInWithPasskey(using: FakePasskey())
		#expect(form.canSubmit && form.password == "fallback" && store.load() == nil)
		#expect(form.notice == "That passkey did not sign you in. Try again for a new challenge, or use your password.")
		await form.signInWithPasskey(using: FakePasskey())
		#expect(name == "robin" && transport.requests[2].url?.path == "/api/login/challenge")
	}

	@Test("invalid challenge bytes, another RP, missing cookie and unsupported verification are refused before authorization", arguments: [
		challengeReply.replacingOccurrences(of: "AAEC_f7_", with: "bad!"),
		challengeReply.replacingOccurrences(of: "mainworthy.example", with: "other.example"),
		challengeReply.replacingOccurrences(of: "required", with: "discouraged"),
		"missing cookie",
	])
	func malformed(_ body: String) async {
		let transport = PasskeyTransport([start(body == "missing cookie" ? challengeReply : body, cookie: body != "missing cookie")])
		let form = form(transport, store: MemoryStore())
		let authorization = FakePasskey()
		await form.signInWithPasskey(using: authorization)
		#expect(form.notice == ClientError.unreadable.message)
		#expect(authorization.asked == nil && !form.isWorking && transport.requests.count == 1)
	}
}
