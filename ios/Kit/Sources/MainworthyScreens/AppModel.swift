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
	private let remembered: Remembered
	private var server: Server?
	private var watching: Task<Void, Never>?

	/// The app as it runs on a device: the session in the keychain, requests over the network.
	///
	/// - Parameters:
	///   - version: The app's version, which the server shows beside the session it opens.
	///   - forgetting: Start signed out, with nothing remembered. A test of the screens asks for it.
	public static func live(version: String, forgetting: Bool = false) -> AppModel {
		let secrets = KeychainStore(service: "com.mainworthy.app")
		if forgetting {
			secrets.save(nil)
			Remembered(.standard).forget()
		}
		return AppModel(
			secrets: secrets, transport: URLSessionTransport(), userAgent: "Mainworthy for iPhone \(version)",
			defaults: .standard
		)
	}

	package init(secrets: any SecretStore, transport: any Transport, userAgent: String, defaults: UserDefaults) {
		self.secrets = secrets
		self.transport = transport
		self.userAgent = userAgent
		remembered = Remembered(defaults)
	}

	/// Called once, when the app opens: picks up the session the device holds, or shows the sign-in form.
	public func start() async {
		guard case .starting = phase else { return }
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
		do {
			open(server, as: try await server.account())
		} catch ClientError.signedOut {
			showSignIn(saying: "Your session ended. Sign in again.")
		} catch {
			phase = .unreachable(error.shown)
		}
	}

	private func open(_ server: Server, as account: Account) {
		self.server = server
		remembered.address = server.instance.name
		let workspace = Workspace(
			server: server, account: account, remembered: remembered,
			onSignedOut: { [weak self] in self?.showSignIn(saying: nil) }
		)
		phase = .signedIn(workspace)
		// The server can end the session at any request: it ran out, or was ended from another device.
		watching?.cancel()
		watching = Task { [weak self] in
			for await _ in server.sessionEnded {
				self?.showSignIn(saying: "Your session ended. Sign in again.")
				return
			}
		}
	}

	private func showSignIn(saying notice: String?) {
		watching?.cancel()
		server = nil
		phase = .signedOut(form(saying: notice))
	}

	private func form(saying notice: String? = nil) -> SignInForm {
		SignInForm(
			address: remembered.address, notice: notice,
			connect: { [secrets, transport, userAgent] instance in
				Server(instance: instance, secrets: secrets, transport: transport, userAgent: userAgent)
			},
			onSignedIn: { [weak self] server, account in self?.open(server, as: account) }
		)
	}
}

/// What the device remembers that is no secret: the address last signed in to, and the project last open.
@MainActor
final class Remembered {
	private let defaults: UserDefaults

	init(_ defaults: UserDefaults) {
		self.defaults = defaults
	}

	var address: String {
		get { defaults.string(forKey: "mainworthy.address") ?? "" }
		set { defaults.set(newValue, forKey: "mainworthy.address") }
	}

	var project: String? {
		get { defaults.string(forKey: "mainworthy.project") }
		set { defaults.set(newValue, forKey: "mainworthy.project") }
	}

	func forget() {
		defaults.removeObject(forKey: "mainworthy.address")
		defaults.removeObject(forKey: "mainworthy.project")
	}
}
