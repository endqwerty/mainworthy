import Foundation
import MainworthyClient
import Synchronization
import Testing

@testable import MainworthyScreens

private let pendingReply = #"{"ok":true,"result":{"signedIn":false,"secondFactor":{"challenge":"pending","expiresAt":1800000300000}}}"#
private let ceremony = String(repeating: "c", count: 43)

private final class SecondFactorTransport: Transport {
	struct Reply { let body: String; var status = 200; var headers: [String: String] = [:] }
	private let state: Mutex<(requests: [URLRequest], replies: [Reply])>
	init(_ replies: [Reply]) { state = Mutex(([], replies)) }
	var requests: [URLRequest] { state.withLock { $0.requests } }
	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let reply = state.withLock { state -> Reply? in
			state.requests.append(request)
			return state.replies.isEmpty ? nil : state.replies.removeFirst()
		}
		guard let reply else { throw URLError(.networkConnectionLost) }
		return (Data(reply.body.utf8), HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: reply.headers)!)
	}
	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, Error>, HTTPURLResponse) { throw URLError(.unsupportedURL) }
}

@Suite("Authenticator sign-in") @MainActor
struct SecondFactorSignInTests {
	private let instance = Instance(address: "https://mainworthy.example")!
	private var pending: SecondFactorTransport.Reply {
		.init(body: pendingReply, headers: ["Set-Cookie": "__Host-mainworthy_ceremony=\(ceremony); Path=/; Secure; HttpOnly"])
	}
	private var success: [SecondFactorTransport.Reply] {
		[
			.init(body: #"{"ok":true,"result":{"signedIn":true}}"#, headers: ["Set-Cookie": "__Host-mainworthy_sid=\(String(repeating: "s", count: 43)); Path=/; Secure; HttpOnly"]),
			.init(body: #"{"ok":true,"result":{"actor":"robin","actorId":7,"kind":"human","can":[],"mode":"server","via":"cookie","session":2,"owner":false,"version":"0.1.0","projects":[]}}"#),
		]
	}
	private func form(_ transport: SecondFactorTransport, store: MemoryStore, signed: @escaping (Account) -> Void = { _ in }) -> SignInForm {
		SignInForm(instance: instance, notice: nil, connect: { Server(instance: $0, secrets: store, transport: transport) }, onSignedIn: { _, account in signed(account) })
	}
	@Test("an accepted password asks for a code without showing an error or retaining the password")
	func passwordStartsSecondStep() async {
		let instance = Instance(address: "https://mainworthy.example")!
		let transport = SecondFactorTransport([
			.init(body: pendingReply, headers: ["Set-Cookie": "__Host-mainworthy_ceremony=\(ceremony); Path=/; Secure; HttpOnly"])
		])
		let store = MemoryStore()
		var signedIn = false
		let form = SignInForm(instance: instance, notice: nil, connect: {
			Server(instance: $0, secrets: store, transport: transport)
		}, onSignedIn: { _, _ in signedIn = true })
		form.name = "robin"
		form.password = "a password"
		await form.submit()
		#expect(form.notice == nil)
		#expect(form.password.isEmpty)
		#expect(!signedIn && store.load() == nil)
		#expect(!form.isWorking && !form.canSubmit)
		#expect(transport.requests.count == 1)
		#expect(form.needsSecondFactor)
	}

	@Test("the form submits authenticator or recovery codes on the held challenge and clears its secrets on success", arguments: ["123456", "abcdef01-23456789-abcdef01-23456789"])
	func finishesSecondStep(_ code: String) async throws {
		let transport = SecondFactorTransport([pending] + success)
		let store = MemoryStore()
		var signedIn = ""
		let form = form(transport, store: store) { signedIn = $0.name }
		form.name = " robin "; form.password = "a password"
		await form.submit()
		form.code = " \(code)\n"
		#expect(form.canSubmit)
		await form.submit()
		#expect(signedIn == "robin" && !form.needsSecondFactor && form.code.isEmpty && form.password.isEmpty)
		#expect(!form.isWorking && form.notice == nil && store.load() != nil)
		let request = transport.requests[1]
		#expect(try JSONDecoder().decode(JSONValue.self, from: request.httpBody!) == ["challenge": "pending", "code": .string(code)])
		#expect(request.value(forHTTPHeaderField: "Cookie") == "__Host-mainworthy_ceremony=\(ceremony)")
	}

	@Test("a wrong or expired code shows the web's refusal, and Start again discards the challenge")
	func refusedAndRestarted() async throws {
		let refused = SecondFactorTransport.Reply(body: #"{"ok":false,"error":{"code":"unauthenticated","message":"that did not sign you in"}}"#, status: 401)
		let fresh = SecondFactorTransport.Reply(body: pendingReply.replacingOccurrences(of: "pending", with: "fresh"), headers: ["Set-Cookie": "__Host-mainworthy_ceremony=\(ceremony); Path=/; Secure; HttpOnly"])
		let transport = SecondFactorTransport([pending, refused, fresh] + success)
		let store = MemoryStore()
		var signedIn = ""
		let form = form(transport, store: store) { signedIn = $0.name }
		form.name = "robin"; form.password = "a password"
		await form.submit()
		form.code = "wrong"
		await form.submit()
		#expect(form.notice == "That code did not sign you in. Use a new authenticator code or an unused recovery code.")
		#expect(form.needsSecondFactor && form.code == "wrong" && form.canSubmit)
		#expect(store.load() == nil && signedIn.isEmpty && transport.requests.count == 2)
		form.startAgain()
		#expect(!form.needsSecondFactor && form.notice == nil && form.code.isEmpty && form.password.isEmpty && form.name == "robin")
		#expect(!form.canSubmit)
		form.password = "a password"
		await form.submit()
		form.code = "123456"
		await form.submit()
		#expect(signedIn == "robin")
		#expect(try JSONDecoder().decode(JSONValue.self, from: transport.requests[3].httpBody!) == ["challenge": "fresh", "code": "123456"])
	}

	@Test("the form shows the web's wait sentence and keeps the pending attempt without retrying it")
	func limitedCode() async {
		let transport = SecondFactorTransport([pending, .init(body: #"{"ok":false,"error":{"code":"limited","message":"too many attempts"}}"#, status: 429, headers: ["Retry-After": "8"])])
		let store = MemoryStore()
		let form = form(transport, store: store)
		form.name = "robin"; form.password = "a password"
		await form.submit()
		form.code = "123456"
		await form.submit()
		#expect(form.notice == "Too many attempts. Try again in 8 seconds.")
		#expect(form.needsSecondFactor && form.canSubmit && form.code == "123456")
		#expect(store.load() == nil && transport.requests.count == 2)
	}
}
