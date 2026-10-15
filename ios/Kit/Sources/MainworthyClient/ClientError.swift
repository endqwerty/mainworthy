import Foundation

/// Why something the app asked of the server did not happen. Every case has a sentence a screen can show.
public enum ClientError: Error, Equatable, Sendable {
	/// The server was not reached, or the connection was lost before it answered.
	case unreachable(String)
	/// The session ended: the person signs in again.
	case signedOut
	/// Too many failed attempts. The seconds to wait, when the server said.
	case limited(seconds: Int?)
	/// The server said no. `code` is its word for why (`forbidden`, `conflict`, `invalid`); `message` its sentence.
	case refused(code: String, message: String)
	/// The reply was not one this app can read: the address is not a Mainworthy, or the server is newer than
	/// the app.
	case unreadable
	case secondFactorUnsupported

	public var message: String {
		switch self {
		case .unreachable(let why): "The server could not be reached. \(why)"
		case .signedOut: "You are signed out. Sign in again."
		case .limited(let seconds):
			if let seconds, seconds > 0 {
				"Too many attempts. Try again in \(seconds) \(seconds == 1 ? "second" : "seconds")."
			} else {
				"Too many attempts. Try again later."
			}
		case .refused(_, let message): message.prefix(1).uppercased() + message.dropFirst()
		case .secondFactorUnsupported:
			"This account needs an authenticator or recovery code. This build does not support the second sign-in step yet. Use the web app to sign in."
		case .unreadable:
			"The reply could not be read. Install a newer build of the app: the server may be ahead of it."
		}
	}
}

extension Error {
	/// What a screen says of any error: the client's own sentence, or the system's.
	public var shown: String {
		(self as? ClientError)?.message ?? localizedDescription
	}
}
