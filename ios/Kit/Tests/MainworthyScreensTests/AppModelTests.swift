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
		await workspace.refresh()
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
