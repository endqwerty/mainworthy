import Foundation
import MainworthyClient
import Observation

/// The sign-in form: where the instance is, and a name with a password.
@MainActor @Observable
public final class SignInForm {
	public var address: String
	public var name = ""
	public var password = ""
	/// What the form says above its fields: why the person is here again, or why the last attempt failed.
	public private(set) var notice: String?
	public private(set) var isWorking = false

	private let connect: (Instance) -> Server
	private let onSignedIn: (Server, Account) -> Void

	init(
		address: String, notice: String?, connect: @escaping (Instance) -> Server,
		onSignedIn: @escaping (Server, Account) -> Void
	) {
		self.address = address
		self.notice = notice
		self.connect = connect
		self.onSignedIn = onSignedIn
	}

	public var canSubmit: Bool {
		!isWorking && !address.trimmingCharacters(in: .whitespaces).isEmpty
			&& !name.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
	}

	public func submit() async {
		guard canSubmit else { return }
		guard let instance = Instance(address: address) else {
			notice = "That is not an address. Write it as you would in a browser: mainworthy.example"
			return
		}
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
