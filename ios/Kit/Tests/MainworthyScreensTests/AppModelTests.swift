import Foundation
import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("The app, from sign-in to sign-out", .enabled(if: Live.isRunning, "needs the server `bun scripts/ios.ts test` starts"))
@MainActor
struct AppModelTests {
	/// The app on a device of its own: its secret and what it remembers are this test's.
	struct Device {
		let secrets = MemoryStore()
		let defaults: UserDefaults

		init() {
			let name = "mainworthy-tests-\(UUID().uuidString)"
			defaults = UserDefaults(suiteName: name)!
			defaults.removePersistentDomain(forName: name)
		}

		@MainActor func app() -> AppModel {
			AppModel(secrets: secrets, transport: URLSessionTransport(), userAgent: "Mainworthy tests", defaults: defaults)
		}
	}

	func form(_ app: AppModel) throws -> SignInForm {
		guard case .signedOut(let form) = app.phase else { throw Unexpected(app.phase) }
		return form
	}

	func workspace(_ app: AppModel) throws -> Workspace {
		guard case .signedIn(let workspace) = app.phase else { throw Unexpected(app.phase) }
		return workspace
	}

	struct Unexpected: Error {
		let phase: String
		init(_ phase: AppModel.Phase) { self.phase = "\(phase)" }
	}

	@Test("a new device shows the sign-in form; signing in opens a project; the next start is signed in; signing out ends it")
	func signInAndOut() async throws {
		_ = try await Live.project()
		let device = Device()
		let app = device.app()
		await app.start()
		let form = try form(app)
		#expect(form.address.isEmpty && !form.canSubmit)
		form.address = Live.address
		form.name = Live.name
		form.password = "not the password"
		#expect(form.canSubmit)
		await form.submit()
		#expect(form.notice == "That did not sign you in. Check the name and the password.")
		form.password = Live.password
		await form.submit()
		let workspace = try workspace(app)
		#expect(workspace.account.name == Live.name)
		#expect(workspace.project != nil && workspace.queue != nil)
		#expect(form.password.isEmpty)

		// The app is closed and opened again.
		let again = device.app()
		await again.start()
		let kept = try self.workspace(again)
		#expect(kept.account.name == Live.name)
		#expect(kept.project == workspace.project)

		await kept.signOut()
		let back = try self.form(again)
		// The address is remembered, and nothing that signs anybody in.
		#expect(back.address == Live.instance.name && back.name.isEmpty && back.password.isEmpty)
		#expect(device.secrets.load() == nil)
		let third = device.app()
		await third.start()
		_ = try self.form(third)
	}

	@Test("a token signs the owner in")
	func token() async throws {
		let app = Device().app()
		await app.start()
		let form = try form(app)
		form.address = Live.address
		form.way = .token
		form.token = "  \(Live.token)\n"
		await form.submit()
		#expect(try workspace(app).account.isOwner)
	}

	@Test("the project that was open is open again at the next start, and another project has its own queue")
	func projects() async throws {
		let first = try await Live.project()
		let second = try await Live.project()
		let device = Device()
		let app = device.app()
		await app.start()
		let form = try form(app)
		form.address = Live.address
		form.name = Live.name
		form.password = Live.password
		await form.submit()
		let workspace = try workspace(app)
		let chosen = try #require(workspace.account.projects.first { $0.key == second })
		workspace.open(chosen)
		let queue = try #require(workspace.queue)
		await queue.show(.open, filter: nil)
		#expect(!queue.questions.isEmpty)
		workspace.open(try #require(workspace.account.projects.first { $0.key == first }))
		#expect(workspace.queue !== queue)
		workspace.open(chosen)

		let again = device.app()
		await again.start()
		#expect(try self.workspace(again).project?.key == second)
	}

	@Test("a session that was ended elsewhere shows the sign-in form and says why")
	func endedElsewhere() async throws {
		let device = Device()
		let app = device.app()
		await app.start()
		let form = try form(app)
		form.address = Live.address
		form.name = Live.name
		form.password = Live.password
		await form.submit()
		let workspace = try workspace(app)
		// The session is ended from another place: here, by a second holder of the same cookie.
		await Server.kept(in: device.secrets)?.signOut()
		await workspace.refreshAccount()
		try await Task.sleep(for: .milliseconds(50))
		#expect(try self.form(app).notice == "Your session ended. Sign in again.")
	}

	@Test("an address that is no address, and one that is no Mainworthy, are said so")
	func badAddress() async throws {
		let app = Device().app()
		await app.start()
		let form = try form(app)
		form.address = "not an address"
		form.name = "robin"
		form.password = "a password"
		await form.submit()
		#expect(form.notice?.hasPrefix("That is not an address.") == true)
		form.address = "127.0.0.1:9"
		await form.submit()
		#expect(form.notice?.hasPrefix("The server could not be reached.") == true)
	}
}

/// A transport that signs anybody in, and whose answer to "who am I" waits until the test lets it go.
final class Held: Transport, @unchecked Sendable {
	private let gate = AsyncStream.makeStream(of: Void.self)
	private let asked = AsyncStream.makeStream(of: Void.self)
	var holding = false

	/// Returns once the app has asked who is signed in.
	func wasAsked() async {
		for await _ in asked.stream { return }
	}

	func release() {
		gate.continuation.yield()
	}

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		func reply(_ body: String, headers: [String: String] = [:]) -> (Data, HTTPURLResponse) {
			(Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: headers)!)
		}
		switch request.url?.path() {
		case "/api/login":
			let cookie = "mainworthy_sid=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ; Path=/; HttpOnly"
			return reply(#"{"ok":true,"result":{"signedIn":true}}"#, headers: ["Set-Cookie": cookie])
		case "/api/session":
			if holding {
				asked.continuation.yield()
				for await _ in gate.stream { break }
			}
			return reply(
				#"{"ok":true,"result":{"actor":"robin","kind":"human","can":[],"mode":"server","via":"cookie","session":1,"owner":true,"version":"0.1.0","projects":[]}}"#
			)
		default:
			return reply(#"{"ok":true,"result":{}}"#)
		}
	}

	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		throw URLError(.unsupportedURL)
	}
}

@Suite("The app, when a reply comes late")
@MainActor
struct AppModelLateReplyTests {
	@Test("the reply to a start that was given up does not sign the person back in")
	func lateAccount() async throws {
		let secrets = MemoryStore()
		let transport = Held()
		let instance = try #require(Instance(address: "mainworthy.example"))
		_ = try await Server(instance: instance, secrets: secrets, transport: transport).signIn(.token("a token"))
		let name = "mainworthy-tests-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: name))
		defer { defaults.removePersistentDomain(forName: name) }
		let app = AppModel(secrets: secrets, transport: transport, userAgent: "Mainworthy tests", defaults: defaults)

		// The app starts and asks who is signed in. Before the server answers, the person gives up and signs out.
		transport.holding = true
		let starting = Task { await app.start() }
		await transport.wasAsked()
		await app.signOut()
		guard case .signedOut = app.phase else {
			Issue.record("signing out did not show the sign-in form")
			return
		}
		transport.release()
		await starting.value
		guard case .signedOut = app.phase else {
			Issue.record("the late reply signed the person back in: \(app.phase)")
			return
		}
		#expect(secrets.load() == nil)
	}
}
