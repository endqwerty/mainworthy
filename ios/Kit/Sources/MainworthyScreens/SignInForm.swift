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
	/// What the form says above its fields: why the person is here again, or why the last attempt failed.
	public private(set) var notice: String?
	public private(set) var isWorking = false
	public private(set) var providerName: String?

	private let connect: (Instance) -> Server
	private let onSignedIn: (Server, Account) -> Void

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
		!isWorking && !name.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
	}

	public func loadMethods() async {
		providerName = try? await connect(instance).providerName()
	}

	public func signInWithProvider(using authenticate: @MainActor (URL, String) async throws -> URL) async {
		guard providerName != nil, !isWorking else { return }
		isWorking = true
		defer { isWorking = false }
		let server = connect(instance)
		do {
			let attempt = try await server.beginProviderSignIn()
			let back = try await authenticate(attempt.url, "com.mainworthy.app")
			let account = try await server.finishProviderSignIn(attempt, callback: back)
			password = ""
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
		guard !isWorking else { return }
		isWorking = true
		defer { isWorking = false }
		let server = connect(instance)
		do {
			let attempt = try await server.beginPasskeySignIn()
			let assertion = try await authorization.authorize(attempt.request)
			try Task.checkCancellation()
			let account = try await server.signIn(.passkey(assertion, ceremony: attempt.ceremony))
			password = ""
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
		let server = connect(instance)
		do {
			let account = try await server.signIn(
				.password(name: name.trimmingCharacters(in: .whitespaces), password: password))
			// The password does not outlive the attempt that used it.
			password = ""
			onSignedIn(server, account)
		} catch ClientError.refused(code: "unauthenticated", _) {
			notice = "That did not sign you in. Check the name and the password."
		} catch {
			notice = error.shown
		}
	}
}
