import Foundation
import MainworthyClient
import Observation

/// The sign-in form: where the instance is, and a name with a password or a token.
@MainActor @Observable
public final class SignInForm {
	public enum Way: Hashable, Sendable {
		case password, token
	}

	public var address: String
	public var way = Way.password
	public var name = ""
	public var password = ""
	public var token = ""
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
		guard !isWorking, !address.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
		return switch way {
		case .password: !name.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
		case .token: !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
		}
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
		let proof: Proof =
			switch way {
			case .password: .password(name: name.trimmingCharacters(in: .whitespaces), password: password)
			case .token: .token(token.trimmingCharacters(in: .whitespacesAndNewlines))
			}
		do {
			let account = try await server.signIn(proof)
			// Neither secret outlives the attempt that used it.
			password = ""
			token = ""
			onSignedIn(server, account)
		} catch ClientError.refused(code: "unauthenticated", _) {
			notice =
				way == .password
				? "That did not sign you in. Check the name and the password."
				: "That did not sign you in. Check the token."
		} catch {
			notice = error.shown
		}
	}
}
