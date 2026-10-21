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
	{"ok":true,"result":{"actor":"robin","actorId":1,"kind":"human","can":[],"mode":"server","via":"cookie","session":7,
	"owner":true,"version":"0.1.0","projects":[
	{"key":"shop","identity":"shop-identity","name":"Shop","policy":"standard","can":["read","produce","answer"]},
	{"key":"sealed","identity":"sealed-identity","name":"Sealed","policy":"strict","can":["record"]}]}}
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
		#expect(account.name == "robin" && account.actorId == 1 && account.isOwner)
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

	@Test("a second sign-in step says it is unsupported and stores no cookie")
	func secondFactorIsExplicit() async {
		let needed = #"{"ok":true,"result":{"signedIn":false,"secondFactor":{"challenge":"pending","expiresAt":1800000300000}}}"#
		let script = Script(.json(needed))
		let secrets = MemoryStore()
		let client = server(script, secrets: secrets)
		await #expect(throws: ClientError.secondFactorUnsupported) {
			_ = try await client.signIn(.password(name: "robin", password: "a password"))
		}
		#expect(secrets.load() == nil)
		#expect(client.cookieHeader == nil)
		#expect(script.asked.count == 1)
	}

	@Test("a proof the server refuses is a refusal to show, and no session ends")
	func signInRefused() async {
		let refused = #"{"ok":false,"error":{"code":"unauthenticated","message":"that did not sign you in"}}"#
		let script = Script(.json(status: 401, refused))
		await #expect(throws: ClientError.refused(code: "unauthenticated", message: "that did not sign you in")) {
			_ = try await server(script).signIn(.password(name: "robin", password: "wrong"))
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
		_ = try await server.signIn(.password(name: "robin", password: "a password"))
		#expect(secrets.load() != nil)
		await #expect(throws: ClientError.signedOut) {
			let _: JSONValue = try await server.read("inbox", in: "shop", [:])
		}
		#expect(secrets.load() == nil)
		var told = server.sessionEnded.makeAsyncIterator()
		await told.next()
	}

	@Test("a late 401 for a session that was replaced does not take the new session with it")
	func lateRefusalOfAnOldSession() async throws {
		let secrets = MemoryStore()
		let old = Script(
			.json(signedIn, headers: ["Set-Cookie": "mainworthy_sid=\(cookie); Path=/; HttpOnly"]), .json(session),
			.json(status: 401, unauthenticated)
		)
		let first = server(old, secrets: secrets)
		_ = try await first.signIn(.password(name: "robin", password: "a password"))
		// The person signs in again, on a new connection that keeps its session in the same place.
		let newer = String(cookie.reversed())
		let second = server(
			Script(.json(signedIn, headers: ["Set-Cookie": "mainworthy_sid=\(newer); Path=/; HttpOnly"]), .json(session)),
			secrets: secrets
		)
		_ = try await second.signIn(.password(name: "robin", password: "a password"))
		// Now the old connection hears that its session is over.
		await #expect(throws: ClientError.signedOut) { _ = try await first.account() }
		#expect(String(decoding: secrets.load() ?? Data(), as: UTF8.self).contains(newer))
	}

	@Test("too many attempts says how long to wait")
	func limited() async {
		let body = #"{"ok":false,"error":{"code":"limited","message":"too many failed attempts; try again in 8 seconds"}}"#
		let script = Script(.json(status: 429, body, headers: ["Retry-After": "8"]))
		await #expect(throws: ClientError.limited(seconds: 8)) {
			_ = try await server(script).signIn(.password(name: "robin", password: "wrong"))
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
			_ = try await server(Script(.json(body))).project("shop", identity: "shop-identity").questions(open: true)
		}
	}

	@Test("a question whose evidence cannot be read, or whose kind is new, is listed and has no answer to give here")
	func unreadableEvidence() async throws {
		func question(_ ref: String, kind: String, evidence: String, answers: String) -> String {
			"""
			{"q":"\(ref)","kind":"\(kind)","title":"A question","producer":"ci","state":"open","evidence":\(evidence),
			"evidenceHash":"abc","seen":{"count":1,"carried":0},"needs":"one member","answers":\(answers),"blocks":[],
			"about":[],"openedAt":1800000000000,"advice":[],"decision":null,"you":"counts"}
			"""
		}
		let inbox = """
			{"ok":true,"seq":3,"result":{"counts":{"open":3,"failure":2},"cursor":null,"items":[
			\(question("Q-1", kind: "failure", evidence: #"{"message":7}"#, answers: #"["flaky","infra"]"#)),
			\(question("Q-2", kind: "waiver", evidence: #"{"until":"friday"}"#, answers: #"["grant"]"#)),
			\(question("Q-3", kind: "failure", evidence: #"{"message":null,"scope":"trunk","tests":[],"count":0,"target":"abc","hints":[],"facts":[]}"#, answers: #"["flaky","quarantine"]"#))]}}
			"""
		let script = Script(.json(inbox))
		let project = server(script).project("shop", identity: "shop-identity")
		let questions = try await project.questions(open: true).questions
		#expect(questions.map(\.evidence) == [.unreadable, .unreadable, questions[2].evidence])
		#expect(questions[1].kind == .other("waiver") && questions[1].stakes.isEmpty)
		#expect(questions[0].choices.map(\.takes) == [.more, .more])
		#expect(questions[1].choices.map(\.takes) == [.more])
		// A known question can be answered, but not with an answer this build has no words for.
		#expect(questions[2].choices.map(\.takes) == [.nothing, .more])
		for question in questions {
			for choice in question.choices where choice.takes == .more {
				#expect(try await project.answer(question, with: choice) == .notTaken("an answer this build can give; open the question in the web app"))
			}
		}
		// Nothing was sent for any of them.
		#expect(script.asked.count == 1)
	}

	@Test("a proposal that does more than change what a case says has no answer to give here")
	func proposalNotShownWhole() async throws {
		func adopt(_ ref: String, edits: String, count: Int) -> String {
			"""
			{"q":"\(ref)","kind":"adopt","title":"An edit","producer":"agent","state":"open","evidenceHash":"abc",
			"evidence":{"proposal":"P-1","author":"reviewer","reason":null,"edits":\(edits),"count":\(count),"conflicts":[],"facts":[]},
			"seen":{"count":1,"carried":0},"needs":"one member","answers":["accept","reject"],"blocks":[],"about":[],
			"openedAt":1800000000000,"advice":[],"decision":null,"you":"counts"}
			"""
		}
		let edit = #"{"op":"edit","case":"C-1","title":"A case","base":1,"conflicts":[]}"#
		let inbox = """
			{"ok":true,"seq":3,"result":{"counts":{"open":3,"adopt":3},"cursor":null,"items":[
			\(adopt("Q-1", edits: "[\(edit)]", count: 1)),
			\(adopt("Q-2", edits: #"[\#(edit),{"op":"place","cases":3}]"#, count: 2)),
			\(adopt("Q-3", edits: "[\(edit)]", count: 40)),
			\(adopt("Q-4", edits: #"[{"op":"create","title":"A new case","steps":2}]"#, count: 1)),
			\(adopt("Q-5", edits: #"[{"op":"restore","case":"C-1","title":"A case"}]"#, count: 1))]}}
			"""
		let questions = try await server(Script(.json(inbox))).project("shop", identity: "shop-identity").questions(open: true).questions
		// Content proposals can be read whole even beyond the summaries. Moves and restores remain blocked.
		#expect(questions.map { $0.choices.map(\.takes) } == [
			[.nothing, .nothing], [.more, .more], [.nothing, .nothing], [.nothing, .nothing], [.more, .more],
		])
		// Unsupported edits still explain why they need the web app.
		let why = questions.map { question -> ProposedEdit.NotShown? in
			if case .proposal(let edit) = question.evidence { edit.notShown } else { nil }
		}
		#expect(why == [nil, .otherThanContent, nil, nil, .otherThanContent])
	}

	@Test("a proposal's reply that lacks a document is unreadable, not a smaller change")
	func incompleteDocuments() async throws {
		let inbox = """
			{"ok":true,"seq":3,"result":{"counts":{"open":1,"adopt":1},"cursor":null,"items":[
			{"q":"Q-1","kind":"adopt","title":"An edit","producer":"agent","state":"open","evidenceHash":"abc",
			"evidence":{"proposal":"P-1","author":"reviewer","reason":null,"count":2,"conflicts":[],"facts":[],
			"edits":[{"op":"edit","case":"C-1","title":"A case"},{"op":"create","title":"A new case"}]},
			"seen":{"count":1,"carried":0},"needs":"one member","answers":["accept","reject"],"blocks":[],"about":[],
			"openedAt":1800000000000,"advice":[],"decision":null,"you":"counts"}]}}
			"""
		let body = #"{"title":"A case","pre":"","steps":[],"methods":["human"],"automate":"none","fields":{}}"#
		let partial = #"{"title":"A case","pre":"","steps":[],"methods":["human"],"automate":"none"}"#
		let edited = #"{"op":"edit","case":"C-1","body":\#(body),"current":\#(body)}"#
		let created = #"{"op":"create","body":\#(body),"folder":"Checkout","tags":["checkout"],"covers":[]}"#
		func documents(_ edits: String) async throws -> [EditedCase] {
			let reply = #"{"ok":true,"seq":3,"result":[{"ref":"P-1","count":2,"cursor":null,"edits":[\#(edits)]}]}"#
			let project = server(Script(.json(inbox), .json(reply))).project("shop", identity: "shop-identity")
			let question = try #require(try await project.questions(open: true).questions.first)
			guard case .proposal(let edit) = question.evidence else { throw ClientError.unreadable }
			return try await project.documents(of: edit)
		}
		// The whole reply is read as the two cases the question counted.
		#expect(try await documents("\(edited),\(created)").map(\.caseRef) == ["C-1", nil])
		// One with a part missing is not read as what is left of it.
		let incomplete = [
			edited,  // one document of two
			#"\#(edited),{"op":"create","folder":"Checkout","tags":[],"covers":[]}"#,  // a new case without its content
			#"{"op":"edit","case":"C-1","body":\#(body)},\#(created)"#,  // an edit without the case as it is
			#"\#(edited),{"op":"create","body":\#(body)}"#,  // a new case without where it goes
			#"\#(edited),{"op":"create","body":\#(partial),"folder":"Checkout","tags":[],"covers":[]}"#,  // content without its fields
			"",
		]
		for edits in incomplete {
			await #expect(throws: ClientError.unreadable) { _ = try await documents(edits) }
		}
	}

	@Test("a suggestion says which step it changes, which is not always the step the finding is on")
	func suggestionTarget() async throws {
		func finding(_ suggest: String) -> String {
			"""
			{"ok":true,"seq":3,"result":{"counts":{"open":1,"finding":1},"cursor":null,"items":[
			{"q":"Q-1","kind":"finding","title":"A finding","producer":"agent","state":"open","evidenceHash":"abc",
			"evidence":{"on":"C-1#s1","case":"C-1","caseTitle":"A case","step":"s1","category":"ambiguous","note":"Unclear.",
			"repro":null,"suggest":\(suggest),"finder":"reviewer","lens":"review","facts":[]},
			"seen":{"count":1,"carried":0},"needs":"one member","answers":["accept","reject"],"blocks":[],"about":[],
			"openedAt":1800000000000,"advice":[],"decision":null,"you":"counts"}]}}
			"""
		}
		func suggestion(_ suggest: String) async throws -> Finding.Suggestion? {
			let questions = try await server(Script(.json(finding(suggest)))).project("shop", identity: "shop-identity").questions(open: true)
			guard case .finding(let found) = questions.questions.first?.evidence else { throw ClientError.unreadable }
			return found.suggestion
		}
		// The server edits the step the suggestion names. Where it names none, the step the finding is on.
		#expect(try await suggestion(#"{"step":"s2","expected":"New"}"#) == .step("s2", action: nil, expected: "New"))
		#expect(try await suggestion(#"{"expected":"New"}"#) == .step("s1", action: nil, expected: "New"))
		#expect(try await suggestion("null") == nil)
		#expect(
			try await suggestion(#"{"case":{"title":"A new case","folder":"Checkout","steps":["Open the cart"]}}"#)
				== .newCase(title: "A new case", folder: "Checkout", steps: ["Open the cart"]))
	}

	@Test("a refusal carries the server's sentence")
	func refused() async {
		let body = #"{"ok":false,"error":{"code":"forbidden","message":"inbox needs the read capability on shop"}}"#
		await #expect(throws: ClientError.refused(code: "forbidden", message: "inbox needs the read capability on shop")) {
			_ = try await server(Script(.json(status: 403, body))).project("shop", identity: "shop-identity").questions(open: true)
		}
		#expect(
			ClientError.refused(code: "forbidden", message: "inbox needs the read capability on shop").message
				== "Inbox needs the read capability on shop")
	}
}
