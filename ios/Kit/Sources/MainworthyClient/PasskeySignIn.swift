import Foundation

/// The challenge and relying party supplied by the selected instance.
public struct PasskeyRequest: Sendable, Equatable {
	public let relyingParty: String
	public let challenge: Data
}

/// The bytes returned by AuthenticationServices, encoded for the server only at completion.
public struct PasskeyAssertion: Sendable {
	public let credentialID: Data
	public let clientDataJSON: Data
	public let authenticatorData: Data
	public let signature: Data
	public let userID: Data

	public init(credentialID: Data, clientDataJSON: Data, authenticatorData: Data, signature: Data, userID: Data) {
		self.credentialID = credentialID
		self.clientDataJSON = clientDataJSON
		self.authenticatorData = authenticatorData
		self.signature = signature
		self.userID = userID
	}

	package var answer: JSONValue {
		["id": .string(credentialID.base64url), "clientDataJSON": .string(clientDataJSON.base64url),
		 "authenticatorData": .string(authenticatorData.base64url), "signature": .string(signature.base64url),
		 "userHandle": .string(userID.base64url)]
	}
}

/// An assertion is requested only after the server has issued a challenge. The app supplies Apple's adapter.
@MainActor public protocol PasskeyAuthorizing {
	func authorize(_ request: PasskeyRequest) async throws -> PasskeyAssertion
}

public enum PasskeyAuthorizationError: Error, LocalizedError {
	case unavailable
	public var errorDescription: String? {
		"This app could not use a passkey for this instance. Sign in with your password."
	}
}

package struct PasskeySignIn: Sendable {
	package let request: PasskeyRequest
	package let ceremony: String

	init(_ wire: Wire.PasskeyChallenge, response: HTTPURLResponse, instance: Instance) throws {
		let options = wire.passkey
		guard instance.url.scheme == "https", options.rpId == instance.url.host(),
			options.userVerification == "required",
			!options.challenge.isEmpty, options.challenge.count <= 1024,
			options.challenge.wholeMatch(of: /[A-Za-z0-9_-]+/) != nil,
			let challenge = Data(base64Encoded: options.challenge.replacingOccurrences(of: "-", with: "+")
				.replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - options.challenge.count % 4) % 4)),
			!challenge.isEmpty, challenge.base64url == options.challenge,
			let header = response.value(forHTTPHeaderField: "Set-Cookie"),
			let found = header.firstMatch(of: /(?:^|[,\s])((?:__Host-)?mainworthy_ceremony)=([A-Za-z0-9_-]{43})(?:[;,\s]|$)/)
		else { throw ClientError.unreadable }
		request = PasskeyRequest(relyingParty: options.rpId, challenge: challenge)
		ceremony = "\(found.1)=\(found.2)"
	}
}

private extension Data {
	var base64url: String {
		base64EncodedString().replacingOccurrences(of: "+", with: "-")
			.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
	}
}
