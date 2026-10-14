import Foundation
import Synchronization
import Testing

@testable import MainworthyClient

/// A transport that answers from a list, in order, and keeps what it was asked.
final class Script: Transport {
	enum Reply {
		case json(status: Int = 200, String, headers: [String: String] = [:])
		case lost
	}

	private let state: Mutex<(asked: [URLRequest], replies: [Reply])>

	init(_ replies: Reply...) {
		state = Mutex(([], replies))
	}

	var asked: [URLRequest] { state.withLock { $0.asked } }

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let reply = state.withLock { state -> Reply? in
			state.asked.append(request)
			return state.replies.isEmpty ? nil : state.replies.removeFirst()
		}
		switch reply {
		case .json(let status, let body, let headers):
			let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!
			return (Data(body.utf8), response)
		case .lost, nil:
			throw URLError(.networkConnectionLost)
		}
	}

	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		throw URLError(.unsupportedURL)
	}
}

private let unauthenticated = #"{"ok":false,"error":{"code":"unauthenticated","message":"a token is required"}}"#
private let signedIn = #"{"ok":true,"result":{"signedIn":true}}"#
private let session = """
	{"ok":true,"result":{"actor":"robin","kind":"human","can":[],"mode":"server","via":"cookie","session":7,
	"owner":true,"version":"0.1.0","projects":[
	{"key":"shop","name":"Shop","policy":"standard","can":["read","produce","answer"]},
	{"key":"sealed","name":"Sealed","policy":"strict","can":["record"]}]}}
	"""
private let cookie = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"

@Suite("One exchange with the server")
struct ServerTests {
	let instance = Instance(address: "https://mainworthy.example")!

	func server(_ script: Script, secrets: any SecretStore = MemoryStore()) -> Server {
		Server(instance: instance, secrets: secrets, transport: script)
	}

	@Test("a write whose reply was lost is sent again under the same command id")
	func retriesAWrite() async throws {
		let script = Script(.lost, .json(#"{"ok":true,"result":{"run":"R-1"},"seq":4}"#))
		struct Planned: Decodable { var run: String }
		let reply: Planned = try await server(script).write("plan", in: "shop", ["name": "Smoke"])
		#expect(reply.run == "R-1")
		let bodies = script.asked.map { try? JSONDecoder().decode(JSONValue.self, from: $0.httpBody ?? Data()) }
		#expect(bodies.count == 2)
		#expect(bodies[0] == bodies[1])
		#expect((bodies[0]?["cmd"]?.string ?? "").count >= 8)
		#expect(script.asked[0].url?.absoluteString == "https://mainworthy.example/api/p/shop/plan")
	}

	@Test("two writes are two commands")
	func newCommandEachTime() async throws {
		let ok = #"{"ok":true,"result":{},"seq":1}"#
		let script = Script(.json(ok), .json(ok))
		let server = server(script)
		let _: JSONValue = try await server.write("plan", in: "shop", ["name": "Smoke"])
		let _: JSONValue = try await server.write("plan", in: "shop", ["name": "Smoke"])
		let ids = script.asked.map { (try? JSONDecoder().decode(JSONValue.self, from: $0.httpBody ?? Data()))?["cmd"] }
		#expect(ids[0] != nil && ids[0] != ids[1])
	}

	@Test("a server that never answers is unreachable, after as many tries as the call allows")
	func unreachable() async {
		let script = Script()
		await #expect {
			let _: JSONValue = try await server(script).read("inbox", in: "shop", [:])
		} throws: { error in
			if case ClientError.unreachable = error { true } else { false }
		}
		#expect(script.asked.count == 2)
	}

	@Test("signing in keeps the cookie the server set, under the name it gave it, and nothing else")
	func signInKeepsTheCookie() async throws {
		// Over https the server sets the `__Host-` name and expires the plain one and the former one.
		let cookies = [
			"__Host-mainworthy_sid=\(cookie); Path=/; HttpOnly; SameSite=Strict; Max-Age=1209600; Secure",
			"mainworthy_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure",
			"mainworthy_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure",
		].joined(separator: ", ")
		let script = Script(.json(signedIn, headers: ["Set-Cookie": cookies]), .json(session))
		let secrets = MemoryStore()
		let account = try await server(script, secrets: secrets).signIn(.password(name: "robin", password: "a secret"))
		#expect(account.name == "robin" && account.isOwner)
		// A project the person holds a grant on and may not read is not one the app shows.
		#expect(account.projects.map(\.key) == ["shop"])
		#expect(account.projects[0].may(.answer) && !account.projects[0].may(.admin))
		#expect(script.asked[1].value(forHTTPHeaderField: "Cookie") == "__Host-mainworthy_sid=\(cookie)")
		let kept = String(decoding: secrets.load() ?? Data(), as: UTF8.self)
		#expect(kept.contains(cookie) && !kept.contains("a secret"))
		// The next start of the app finds the session and uses it.
		let again = Script(.json(session))
		_ = try await Server.kept(in: secrets, transport: again)?.account()
		#expect(again.asked.first?.value(forHTTPHeaderField: "Cookie") == "__Host-mainworthy_sid=\(cookie)")
		#expect(again.asked.first?.url?.host() == "mainworthy.example")
	}

	@Test("a proof the server refuses is a refusal to show, and no session ends")
	func signInRefused() async {
		let refused = #"{"ok":false,"error":{"code":"unauthenticated","message":"that did not sign you in"}}"#
		let script = Script(.json(status: 401, refused))
		await #expect(throws: ClientError.refused(code: "unauthenticated", message: "that did not sign you in")) {
			_ = try await server(script).signIn(.token("wrong"))
		}
		#expect(script.asked.count == 1)
	}

	@Test("a 401 on any other request ends the session: the cookie is forgotten and whoever listens is told")
	func sessionEnds() async throws {
		let script = Script(
			.json(signedIn, headers: ["Set-Cookie": "mainworthy_sid=\(cookie); Path=/; HttpOnly"]), .json(session),
			.json(status: 401, unauthenticated)
		)
		let secrets = MemoryStore()
		let server = server(script, secrets: secrets)
		_ = try await server.signIn(.token("a token"))
		#expect(secrets.load() != nil)
		await #expect(throws: ClientError.signedOut) {
			let _: JSONValue = try await server.read("inbox", in: "shop", [:])
		}
		#expect(secrets.load() == nil)
		var told = server.sessionEnded.makeAsyncIterator()
		await told.next()
	}

	@Test("too many attempts says how long to wait")
	func limited() async {
		let body = #"{"ok":false,"error":{"code":"limited","message":"too many failed attempts; try again in 8 seconds"}}"#
		let script = Script(.json(status: 429, body, headers: ["Retry-After": "8"]))
		await #expect(throws: ClientError.limited(seconds: 8)) {
			_ = try await server(script).signIn(.token("wrong"))
		}
		#expect(ClientError.limited(seconds: 8).message == "Too many attempts. Try again in 8 seconds.")
		#expect(ClientError.limited(seconds: 1).message == "Too many attempts. Try again in 1 second.")
	}

	@Test("a reply that is no envelope, or whose result has another shape, is unreadable", arguments: [
		"<html><body>Welcome to nginx</body></html>",
		#"{"ok":true,"result":{"counts":"none"},"seq":1}"#,
	])
	func unreadable(body: String) async {
		await #expect(throws: ClientError.unreadable) {
			_ = try await server(Script(.json(body))).project("shop").questions(open: true)
		}
	}

	@Test("a refusal carries the server's sentence")
	func refused() async {
		let body = #"{"ok":false,"error":{"code":"forbidden","message":"inbox needs the read capability on shop"}}"#
		await #expect(throws: ClientError.refused(code: "forbidden", message: "inbox needs the read capability on shop")) {
			_ = try await server(Script(.json(status: 403, body))).project("shop").questions(open: true)
		}
		#expect(
			ClientError.refused(code: "forbidden", message: "inbox needs the read capability on shop").message
				== "Inbox needs the read capability on shop")
	}
}
