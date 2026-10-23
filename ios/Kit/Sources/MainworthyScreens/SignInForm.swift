import Foundation
import MainworthyClient
import Observation

/// The sign-in form: a password, the configured provider or a passkey, for the instance the app was built for.
/// It does not ask which instance (issue #233).
@MainActor @Observable
public final class SignInForm {
	public let instance: Instance
	public var name = ""
	public var password = ""
	public var code = ""
	/// What the form says above its fields: why the person is here again, or why the last attempt failed.
	public private(set) var notice: String?
	public private(set) var isWorking = false
	public private(set) var providerName: String?

	private let connect: (Instance) -> Server
	private let onSignedIn: (Server, Account) -> Void
	private enum Step {
		case password
		case secondFactor(Server, SecondFactorSignIn)
	}
	private var step: Step = .password
	public var needsSecondFactor: Bool {
		if case .secondFactor = step { true } else { false }
	}

	init(
		instance: Instance, notice: String?, connect: @escaping (Instance) -> Server,
		onSignedIn: @escaping (Server, Account) -> Void
	) {
		self.instance = instance
		self.notice = notice
		self.connect = connect
		self.onSignedIn = onSignedIn
	}

	public var privacyAddress: URL { instance.url.appending(path: "/privacy") }

	public var canSubmit: Bool {
		guard !isWorking else { return false }
		switch step {
		case .password: return !name.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
		case .secondFactor: return !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
		}
	}

	public func startAgain() {
		guard !isWorking else { return }
		step = .password
		code = ""
		password = ""
		notice = nil
	}

	public func loadMethods() async {
		providerName = try? await connect(instance).providerName()
	}

	public func signInWithProvider(using authenticate: @MainActor (URL, String) async throws -> URL) async {
		guard providerName != nil, !isWorking, !needsSecondFactor else { return }
		isWorking = true
		defer { isWorking = false }
		let server = connect(instance)
		do {
			let attempt = try await server.beginProviderSignIn()
			let back = try await authenticate(attempt.url, "com.mainworthy.app")
			let account = try await server.finishProviderSignIn(attempt, callback: back)
			startAfterSignIn()
			onSignedIn(server, account)
		} catch is CancellationError {
			return
		} catch ClientError.refused(code: "unauthenticated", _) {
			notice = "That did not sign you in through the identity provider. Try again, or use your password."
		} catch {
			notice = error.shown
		}
	}

	public func signInWithPasskey(using authorization: any PasskeyAuthorizing) async {
		guard !isWorking, !needsSecondFactor else { return }
		isWorking = true
		defer { isWorking = false }
		let server = connect(instance)
		do {
			let attempt = try await server.beginPasskeySignIn()
			let assertion = try await authorization.authorize(attempt.request)
			try Task.checkCancellation()
			let account = try await server.signIn(.passkey(assertion, ceremony: attempt.ceremony))
			startAfterSignIn()
			onSignedIn(server, account)
		} catch is CancellationError {
			return
		} catch ClientError.refused(code: "native_passkey_unavailable", _) {
			notice = "Passkey sign-in is not available for this instance in this app. Sign in with your password."
		} catch ClientError.refused(code: "unauthenticated", _) {
			notice = "That passkey did not sign you in. Try again for a new challenge, or use your password."
		} catch {
			notice = error.shown
		}
	}

	public func submit() async {
		guard canSubmit else { return }
		isWorking = true
		defer { isWorking = false }
		notice = nil
		let server: Server
		let proof: Proof
		switch step {
		case .password:
			server = connect(instance)
			proof = .password(name: name.trimmingCharacters(in: .whitespaces), password: password)
		case .secondFactor(let held, let attempt):
			server = held
			proof = .secondFactor(attempt, code: code.trimmingCharacters(in: .whitespacesAndNewlines))
		}
		do {
			switch try await server.beginSignIn(proof) {
			case .secondFactor(let attempt):
				password = ""
				code = ""
				step = .secondFactor(server, attempt)
			case .signedIn(let account):
				startAfterSignIn()
				onSignedIn(server, account)
			}
		} catch ClientError.refused(code: "unauthenticated", _) {
			notice = needsSecondFactor
				? "That code did not sign you in. Use a new authenticator code or an unused recovery code."
				: "That did not sign you in. Check the name and the password."
		} catch {
			notice = error.shown
		}
	}

	private func startAfterSignIn() {
		step = .password
		password = ""
		code = ""
		notice = nil
	}
}
