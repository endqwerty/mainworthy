import Foundation
import Synchronization

/// A way of proving who one is at sign-in.
package enum Proof: Sendable {
	case password(name: String, password: String)
	case token(String)
}

/// One Mainworthy, as this app talks to it. It is the only thing that sends a request, and it hides what a
/// request takes: the address of an operation, the envelope around a reply, the session cookie and where it
/// is kept, the id that makes a write safe to send twice, and what a refusal means.
///
/// A person signs in with a name and a password, or with a token. Either opens a session on the server and
/// the reply sets a cookie (`POST /api/login`). The app holds that cookie and nothing else: not the password,
/// and not the token. The server lists the session under "Your sessions", where it can be ended from anywhere.
package final class Server: Sendable {
	package let instance: Instance
	private let transport: any Transport
	private let secrets: any SecretStore
	private let userAgent: String
	private let cookie: Mutex<Cookie?>
	private let ended: (stream: AsyncStream<Void>, continuation: AsyncStream<Void>.Continuation)

	/// The cookie as the server set it. Its name depends on the scheme (`__Host-` over https), so it is kept.
	private struct Cookie: Codable, Equatable {
		var name: String
		var value: String
	}

	private struct Kept: Codable {
		var instance: Instance
		var cookie: Cookie
	}

	/// - Parameter userAgent: What the app calls itself. The server shows it beside the session.
	package init(
		instance: Instance,
		secrets: any SecretStore,
		transport: any Transport = URLSessionTransport(),
		userAgent: String = "Mainworthy for iPhone"
	) {
		self.instance = instance
		self.secrets = secrets
		self.transport = transport
		self.userAgent = userAgent
		cookie = Mutex(nil)
		ended = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
	}

	/// The server the device was last signed in to, with its session, or nil when it holds none.
	package static func kept(
		in secrets: any SecretStore,
		transport: any Transport = URLSessionTransport(),
		userAgent: String = "Mainworthy for iPhone"
	) -> Server? {
		guard let data = secrets.load(), let kept = try? JSONDecoder().decode(Kept.self, from: data) else { return nil }
		let server = Server(instance: kept.instance, secrets: secrets, transport: transport, userAgent: userAgent)
		server.cookie.withLock { $0 = kept.cookie }
		return server
	}

	/// Yields each time the server says the session is over: it ran out, was ended elsewhere, or its person was
	/// removed. Signing out here does not yield. One reader.
	package var sessionEnded: AsyncStream<Void> { ended.stream }

	// MARK: Signing in and out

	/// Opens a session and keeps its cookie. A proof that is refused throws `.refused` with the server's one
	/// sentence, whatever was wrong with it.
	package func signIn(_ proof: Proof) async throws -> Account {
		let body: JSONValue =
			switch proof {
			case .password(let name, let password): ["name": .string(name), "password": .string(password)]
			case .token(let token): ["token": .string(token)]
			}
		let (_, response) = try await send("POST", "/api/login", body: body, attempts: 1, asSignedIn: false)
		guard let given = Server.sessionCookie(in: response, for: instance.url) else { throw ClientError.unreadable }
		cookie.withLock { $0 = given }
		secrets.save(try? JSONEncoder().encode(Kept(instance: instance, cookie: given)))
		return try await account()
	}

	/// Who is signed in, and the projects they may read.
	package func account() async throws -> Account {
		let wire: Wire.SessionInfo = try await exchange("GET", "/api/session", attempts: 2)
		return Account(wire)
	}

	/// Ends the session on the server and forgets its cookie. The cookie is forgotten even when the server
	/// cannot be reached: the device is signed out either way, and the session then ends by itself.
	package func signOut() async {
		_ = try? await send("POST", "/api/logout", body: [:], attempts: 1, asSignedIn: false)
		forget()
	}

	private func forget() {
		cookie.withLock { $0 = nil }
		secrets.save(nil)
	}

	/// The session cookie among the `Set-Cookie` headers of a reply: the one name of the two that carries a value.
	private static func sessionCookie(in response: HTTPURLResponse, for url: URL) -> Cookie? {
		let fields = response.allHeaderFields.reduce(into: [String: String]()) { fields, field in
			if let name = field.key as? String, let value = field.value as? String { fields[name] = value }
		}
		return HTTPCookie.cookies(withResponseHeaderFields: fields, for: url)
			.first { $0.name.hasSuffix("mainworthy_sid") && !$0.value.isEmpty }
			.map { Cookie(name: $0.name, value: $0.value) }
	}

	// MARK: Operations

	/// An operation that changes nothing. `project` is nil for one that is the instance's.
	package func read<Reply: Decodable>(_ operation: String, in project: String?, _ input: JSONValue) async throws -> Reply {
		try await exchange("POST", Server.path(operation, project), body: input, attempts: 2)
	}

	/// An operation that writes. It is sent under a new command id, and sent again under the same id when the
	/// connection fails: the server runs a command once and answers a repeat with the first reply.
	package func write<Reply: Decodable>(_ operation: String, in project: String?, _ input: JSONValue) async throws -> Reply {
		var body = input.object ?? [:]
		body["cmd"] = .string(UUID().uuidString.lowercased())
		return try await exchange("POST", Server.path(operation, project), body: .object(body), attempts: 3)
	}

	/// What changes in a project, as it happens, until the reader stops or the connection is lost. Nothing is
	/// replayed: whoever opens it reads what they show again first.
	package func changes(in project: String) -> AsyncThrowingStream<Change, any Error> {
		let request = self.request("GET", "/api/p/\(Server.escaped(project))/events", body: nil)
		let transport = self.transport
		return AsyncThrowingStream { continuation in
			let reading = Task {
				do {
					let (lines, response) = try await transport.lines(request)
					guard response.statusCode == 200 else { throw ClientError.unreachable("The change stream did not open.") }
					for try await line in lines where line.hasPrefix("data:") {
						let json = Data(line.dropFirst("data:".count).utf8)
						guard let event = try? JSONDecoder().decode(Wire.ChangeEvent.self, from: json) else { continue }
						continuation.yield(Change(operation: event.op, touched: event.touched))
					}
					continuation.finish()
				} catch {
					continuation.finish(throwing: error)
				}
			}
			continuation.onTermination = { _ in reading.cancel() }
		}
	}

	private static func escaped(_ segment: String) -> String {
		segment.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-._~"))) ?? segment
	}

	private static func path(_ operation: String, _ project: String?) -> String {
		project.map { "/api/p/\(escaped($0))/\(operation)" } ?? "/api/\(operation)"
	}

	// MARK: One exchange

	private struct Head: Decodable {
		var ok: Bool
		var error: Refusal?
	}

	private struct Refusal: Decodable {
		var code: String
		var message: String
	}

	private struct Body<Result: Decodable>: Decodable {
		var result: Result
	}

	private func request(_ method: String, _ path: String, body: JSONValue?) -> URLRequest {
		var request = URLRequest(url: instance.url.appending(path: path))
		request.httpMethod = method
		request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		if let held = cookie.withLock({ $0 }) {
			request.setValue("\(held.name)=\(held.value)", forHTTPHeaderField: "Cookie")
		}
		if let body {
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.httpBody = try? JSONEncoder().encode(body)
		}
		return request
	}

	/// Sends a request and returns its reply's result, read as `Result`.
	private func exchange<Result: Decodable>(
		_ method: String, _ path: String, body: JSONValue? = nil, attempts: Int
	) async throws -> Result {
		let (data, _) = try await send(method, path, body: body, attempts: attempts, asSignedIn: true)
		guard let read = try? JSONDecoder().decode(Body<Result>.self, from: data) else { throw ClientError.unreadable }
		return read.result
	}

	/// Sends a request, again when the connection fails, and returns the reply once the server has said yes.
	/// A no is thrown as what it means. `asSignedIn` says a 401 means the session ended, as it does everywhere
	/// but at sign-in, where it means the proof was not accepted.
	private func send(
		_ method: String, _ path: String, body: JSONValue?, attempts: Int, asSignedIn: Bool
	) async throws -> (Data, HTTPURLResponse) {
		let request = self.request(method, path, body: body)
		var failure = ""
		for attempt in 1...attempts {
			let data: Data
			let response: HTTPURLResponse
			do {
				(data, response) = try await transport.send(request)
			} catch {
				// A task that was cancelled is not a server that could not be reached.
				if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw CancellationError() }
				failure = error.localizedDescription
				if attempt < attempts { try await Task.sleep(for: .milliseconds(400 * attempt)) }
				continue
			}
			guard let head = try? JSONDecoder().decode(Head.self, from: data) else { throw ClientError.unreadable }
			if head.ok { return (data, response) }
			let refusal = head.error ?? Refusal(code: "internal", message: "the server refused without saying why")
			switch refusal.code {
			case "unauthenticated" where asSignedIn:
				forget()
				ended.continuation.yield()
				throw ClientError.signedOut
			case "limited":
				throw ClientError.limited(seconds: response.value(forHTTPHeaderField: "Retry-After").flatMap(Int.init))
			default:
				throw ClientError.refused(code: refusal.code, message: refusal.message)
			}
		}
		throw ClientError.unreachable(failure)
	}
}
