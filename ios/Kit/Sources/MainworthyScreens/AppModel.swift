import Foundation
import MainworthyClient
import Observation

/// The app, from its first moment: which of its states it is in, and what moves it to the next. The root view
/// shows one screen for each `Phase` and holds nothing else.
@MainActor @Observable
public final class AppModel {
	public enum Phase {
		/// The device holds a session and the server has not yet said whose.
		case starting
		/// The device holds a session and the server could not be asked. The sentence says why.
		case unreachable(String)
		case signedOut(SignInForm)
		case signedIn(Workspace)
	}

	public private(set) var phase: Phase = .starting

	private let secrets: any SecretStore
	private let transport: any Transport
	private let userAgent: String
	/// The instance the sign-in form signs in to. A session the device already holds may be for another.
	private let instance: Instance
	private let remembered: Remembered
	private var server: Server?
	private var watching: Task<Void, Never>?
	/// The server whose ended sessions `watching` listens for.
	private var watched: Server?
	/// The workspace of a session the server ended. It is kept, with everything typed in its screens, until
	/// somebody signs in again: the same person on the same instance gets it back, anybody else a new one.
	private var suspended: Workspace?
	/// Counts every time the app starts towards being signed in or gives that up, so that the reply to an
	/// attempt that was given up meanwhile changes nothing.
	private var attempt = 0
	private var started = false

	/// The app as it runs on a device: the session in the keychain, requests over the network.
	///
	/// - Parameters:
	///   - version: The app's version, which the server shows beside the session it opens.
	///   - instance: The instance the build names, or the one a test of the screens started.
	///   - forgetting: Start signed out, with nothing remembered. A test of the screens asks for it.
	public static func live(version: String, instance: Instance, forgetting: Bool = false) -> AppModel {
		let secrets = KeychainStore(service: "com.mainworthy.app")
		if forgetting {
			secrets.save(nil)
			Remembered(.standard).forget()
		}
		return AppModel(
			secrets: secrets, transport: URLSessionTransport(), userAgent: "Mainworthy for iPhone \(version)",
			instance: instance, defaults: .standard
		)
	}

	package init(
		secrets: any SecretStore, transport: any Transport, userAgent: String, instance: Instance,
		defaults: UserDefaults
	) {
		self.secrets = secrets
		self.transport = transport
		self.userAgent = userAgent
		self.instance = instance
		remembered = Remembered(defaults)
	}

	/// Called once, when the app opens: picks up the session the device holds, or shows the sign-in form.
	public func start() async {
		guard !started else { return }
		started = true
		guard let kept = Server.kept(in: secrets, transport: transport, userAgent: userAgent) else {
			phase = .signedOut(form())
			return
		}
		server = kept
		await enter(kept)
	}

	/// Asks the server again, from the screen that says it could not be reached.
	public func retry() async {
		guard case .unreachable = phase, let server else { return }
		phase = .starting
		await enter(server)
	}

	/// Gives up the session the device holds, from the screen that says the server could not be reached.
	public func signOut() async {
		await server?.signOut()
		showSignIn(saying: nil)
	}

	private func enter(_ server: Server) async {
		attempt += 1
		let mine = attempt
		do {
			let account = try await server.account()
			guard mine == attempt else { return }
			open(server, as: account)
		} catch ClientError.signedOut {
			guard mine == attempt else { return }
			showSignIn(saying: "Your session ended. Sign in again.")
		} catch {
			guard mine == attempt else { return }
			phase = .unreachable(error.shown)
		}
	}

	private func open(_ server: Server, as account: Account) {
		attempt += 1
		self.server = server
		if let kept = suspended, kept.isOn(server), kept.account.name == account.name {
			// The session was renewed for the same person: their screens, and what they typed in them, come back.
			phase = .signedIn(kept)
			Task { await kept.refreshAccount() }
		} else {
			let workspace = Workspace(
				server: server, account: account, remembered: remembered,
				onSignedOut: { [weak self] in self?.showSignIn(saying: nil) }
			)
			phase = .signedIn(workspace)
		}
		suspended = nil
		watch(server)
	}

	/// Listens for the server ending the session at any request: it ran out, or was ended from another device.
	/// One listener for each server, for as long as the app holds it.
	private func watch(_ server: Server) {
		guard watched !== server else { return }
		watching?.cancel()
		watched = server
		watching = Task { [weak self] in
			for await _ in server.sessionEnded { self?.sessionEnded() }
		}
	}

	/// The server ended the session. The person signs in again, and the workspace waits for them meanwhile: an
	/// editor's draft or a run's notes are not thrown away because a session ran out.
	private func sessionEnded() {
		guard case .signedIn(let workspace) = phase else { return }
		suspended = workspace
		attempt += 1
		phase = .signedOut(form(saying: "Your session ended. Sign in again."))
	}

	/// Signing out, or giving up a session that could not be used: nothing of it is kept.
	private func showSignIn(saying notice: String?) {
		attempt += 1
		watching?.cancel()
		watching = nil
		watched = nil
		suspended = nil
		server = nil
		phase = .signedOut(form(saying: notice))
	}

	private func form(saying notice: String? = nil) -> SignInForm {
		SignInForm(
			instance: instance, notice: notice,
			connect: { [weak self, secrets, transport, userAgent] instance in
				// A session that ended is renewed on the server the workspace that waits for it holds.
				if let kept = self?.server, self?.suspended != nil, kept.instance == instance { return kept }
				return Server(instance: instance, secrets: secrets, transport: transport, userAgent: userAgent)
			},
			onSignedIn: { [weak self] server, account in self?.open(server, as: account) }
		)
	}
}

/// What the device remembers that is no secret: the project last open.
@MainActor
final class Remembered {
	private let defaults: UserDefaults

	init(_ defaults: UserDefaults) {
		self.defaults = defaults
	}

	var project: String? {
		get { defaults.string(forKey: "mainworthy.project") }
		set { defaults.set(newValue, forKey: "mainworthy.project") }
	}

	func forget() {
		defaults.removeObject(forKey: "mainworthy.project")
	}
}
