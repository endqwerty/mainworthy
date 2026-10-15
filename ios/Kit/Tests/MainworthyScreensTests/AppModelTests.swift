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

		@MainActor func app(at instance: Instance = Live.instance) -> AppModel {
			AppModel(
				secrets: secrets, transport: URLSessionTransport(), userAgent: "Mainworthy tests", instance: instance,
				defaults: defaults
			)
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
		// It signs in to the instance the app was given, and asks for a name and a password before it signs anybody in.
		#expect(form.instance == Live.instance && !form.canSubmit)
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
		// Nothing that signs anybody in is kept.
		#expect(back.instance == Live.instance && back.name.isEmpty && back.password.isEmpty)
		#expect(device.secrets.load() == nil)
		let third = device.app()
		await third.start()
		_ = try self.form(third)
	}

	@Test("the owner signs in with a password")
	func owner() async throws {
		let app = Device().app()
		await app.start()
		let form = try form(app)
		form.name = Live.ownerName
		form.password = Live.ownerPassword
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

	@Test("when the server ends the session, signing in again as the same person gives back the same screens")
	func renewedSession() async throws {
		let device = Device()
		let app = device.app()
		await app.start()
		let form = try form(app)
		form.name = Live.name
		form.password = Live.password
		await form.submit()
		let workspace = try workspace(app)
		let queue = try #require(workspace.queue)
		// The session is ended elsewhere, and the app hears of it at its next request.
		await Server.kept(in: device.secrets)?.signOut()
		await workspace.refreshAccount()
		try await Task.sleep(for: .milliseconds(50))
		let again = try self.form(app)
		#expect(again.notice == "Your session ended. Sign in again.")
		again.name = Live.name
		again.password = Live.password
		await again.submit()
		// The same workspace and the same screens, with whatever was typed in them.
		#expect(try self.workspace(app) === workspace)
		#expect(workspace.queue === queue)
		// The renewed session works, and its end is heard again.
		await workspace.refreshAccount()
		#expect(try self.workspace(app) === workspace)
		await Server.kept(in: device.secrets)?.signOut()
		await workspace.refreshAccount()
		try await Task.sleep(for: .milliseconds(50))
		_ = try self.form(app)
	}

	@Test("a case being written when the session ends is still there after the same person signs in again")
	func renewedSessionKeepsDraft() async throws {
		let key = try await Live.project()
		let device = Device()
		let app = device.app()
		await app.start()
		let form = try form(app)
		form.name = Live.name
		form.password = Live.password
		await form.submit()
		let workspace = try workspace(app)
		workspace.open(try #require(workspace.account.projects.first { $0.key == key }))
		let suite = try #require(workspace.suite)
		suite.newCase()
		suite.editor?.content.title = "Typed before the session ended"
		await Server.kept(in: device.secrets)?.signOut()
		await workspace.refreshAccount()
		try await Task.sleep(for: .milliseconds(50))
		let again = try self.form(app)
		again.name = Live.name
		again.password = Live.password
		await again.submit()
		// The suite's review found the draft gone here: the same screen comes back, with the case being written.
		#expect(try self.workspace(app).suite === suite)
		#expect(suite.editor?.content.title == "Typed before the session ended")
	}

	@Test("after a session ends, somebody else who signs in gets screens of their own")
	func renewedByAnother() async throws {
		let device = Device()
		let app = device.app()
		await app.start()
		let form = try form(app)
		form.name = Live.name
		form.password = Live.password
		await form.submit()
		let workspace = try workspace(app)
		await Server.kept(in: device.secrets)?.signOut()
		await workspace.refreshAccount()
		try await Task.sleep(for: .milliseconds(50))
		let again = try self.form(app)
		again.name = Live.ownerName
		again.password = Live.ownerPassword
		await again.submit()
		let other = try self.workspace(app)
		#expect(other !== workspace && other.account.isOwner)
	}

	@Test("signing out keeps nothing: signing in again gives new screens")
	func signOutKeepsNothing() async throws {
		let app = Device().app()
		await app.start()
		let form = try form(app)
		form.name = Live.name
		form.password = Live.password
		await form.submit()
		let workspace = try workspace(app)
		await workspace.signOut()
		let again = try self.form(app)
		again.name = Live.name
		again.password = Live.password
		await again.submit()
		#expect(try self.workspace(app) !== workspace)
	}

	@Test("a session kept for another instance than the build's is renewed on that instance, with its screens")
	func renewedOnKeptInstance() async throws {
		let device = Device()
		_ = try await Server(instance: Live.instance, secrets: device.secrets, transport: URLSessionTransport())
			.signIn(.password(name: Live.name, password: Live.password))
		// The build names an instance that does not answer: a password sent there would be lost.
		let app = device.app(at: try #require(Instance(address: "127.0.0.1:9")))
		await app.start()
		let workspace = try workspace(app)
		await Server.kept(in: device.secrets)?.signOut()
		await workspace.refreshAccount()
		try await Task.sleep(for: .milliseconds(50))
		let again = try self.form(app)
		#expect(again.instance == Live.instance)
		again.name = Live.name
		again.password = Live.password
		await again.submit()
		#expect(try self.workspace(app) === workspace)
	}

	@Test("an instance that does not answer is said so")
	func unreachable() async throws {
		let app = Device().app(at: try #require(Instance(address: "127.0.0.1:9")))
		await app.start()
		let form = try form(app)
		form.name = "robin"
		form.password = "a password"
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
				#"{"ok":true,"result":{"actor":"robin","actorId":1,"kind":"human","can":[],"mode":"server","via":"cookie","session":1,"owner":true,"version":"0.1.0","projects":[]}}"#
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
		_ = try await Server(instance: instance, secrets: secrets, transport: transport).signIn(.password(name: "robin", password: "a password"))
		let name = "mainworthy-tests-\(UUID().uuidString)"
		let defaults = try #require(UserDefaults(suiteName: name))
		defer { defaults.removePersistentDomain(forName: name) }
		let app = AppModel(
			secrets: secrets, transport: transport, userAgent: "Mainworthy tests", instance: instance, defaults: defaults
		)

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
