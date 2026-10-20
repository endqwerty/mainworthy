import CryptoKit
import Foundation

/// One attempt, bound to this client by a verifier that is never stored or sent through the browser.
package struct ProviderSignIn: Sendable {
	package static let callback = "com.mainworthy.app://signin/oidc"
	package let url: URL
	package let proof: Proof

	package struct Proof: Sendable {
		package let verifier = random()
		package let state = random()
		package var challenge: String { Data(SHA256.hash(data: Data(verifier.utf8))).base64url }
		private static func random() -> String { Data((0..<32).map { _ in UInt8.random(in: .min ... .max) }).base64url }
	}

	package func code(from url: URL) throws -> String {
		guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
			parts.scheme == "com.mainworthy.app", parts.host == "signin", parts.path == "/oidc",
			parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
			let items = parts.queryItems,
			items.filter({ $0.name == "state" }).count == 1,
			items.first(where: { $0.name == "state" })?.value == proof.state
		else { throw ClientError.unreadable }
		if items.first(where: { $0.name == "error" })?.value == "limited" {
			guard items.count == 3,
				let wait = items.first(where: { $0.name == "retryAfter" })?.value,
				wait.wholeMatch(of: /[0-9]+/) != nil, let seconds = Int(wait), seconds > 0
			else { throw ClientError.unreadable }
			throw ClientError.limited(seconds: seconds)
		}
		guard items.count == 2 else { throw ClientError.unreadable }
		if items.first(where: { $0.name == "error" })?.value == "unauthenticated" {
			throw ClientError.refused(code: "unauthenticated", message: "That did not sign you in through the identity provider.")
		}
		guard let code = items.first(where: { $0.name == "code" })?.value,
			code.wholeMatch(of: /[A-Za-z0-9_-]{43}/) != nil
		else { throw ClientError.unreadable }
		return code
	}
}

private extension Data {
	var base64url: String {
		base64EncodedString().replacingOccurrences(of: "+", with: "-")
			.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
	}
}
