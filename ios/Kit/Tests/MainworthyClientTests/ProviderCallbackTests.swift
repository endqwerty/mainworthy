import Foundation
import Testing
@testable import MainworthyClient

struct ProviderCallbackTests {
	@Test func aLimitedCallbackCarriesTheSecondsToWait() throws {
		let proof = ProviderSignIn.Proof()
		let attempt = ProviderSignIn(url: URL(string: "https://id.example.com/authorize")!, proof: proof)
		let back = "\(ProviderSignIn.callback)?state=\(proof.state)&error=limited&retryAfter=8"
		#expect(throws: ClientError.limited(seconds: 8)) { try attempt.code(from: URL(string: back)!) }
		for bad in [
			back.replacingOccurrences(of: proof.state, with: "wrong"),
			back.replacingOccurrences(of: "retryAfter=8", with: ""),
			back.replacingOccurrences(of: "retryAfter=8", with: "retryAfter=0"),
			back.replacingOccurrences(of: "retryAfter=8", with: "retryAfter=-1"),
			back.replacingOccurrences(of: "retryAfter=8", with: "retryAfter=1.5"),
			back.replacingOccurrences(of: "retryAfter=8", with: "retryAfter=forever"),
			back.replacingOccurrences(of: "retryAfter=8", with: "retryAfter=99999999999999999999999"),
			back + "&retryAfter=8", back + "&code=\(String(repeating: "c", count: 43))",
			back.replacingOccurrences(of: "error=limited", with: "error=unauthenticated"),
		] {
			#expect(throws: ClientError.unreadable) { try attempt.code(from: URL(string: bad)!) }
		}
	}

	@Test func onlyTheExactCallbackAndStateCanFinishTheAttempt() throws {
		let proof = ProviderSignIn.Proof()
		let attempt = ProviderSignIn(url: URL(string: "https://id.example.com/authorize")!, proof: proof)
		let code = String(repeating: "c", count: 43)
		let good = "\(ProviderSignIn.callback)?state=\(proof.state)&code=\(code)"
		#expect(try attempt.code(from: URL(string: good)!) == code)
		for bad in [
			good.replacingOccurrences(of: "com.mainworthy.app:", with: "other:"),
			good.replacingOccurrences(of: "//signin/", with: "//elsewhere/"),
			good.replacingOccurrences(of: "/oidc?", with: "/oidc/extra?"),
			good.replacingOccurrences(of: proof.state, with: String(repeating: "s", count: 43)),
			good + "&code=\(code)", good + "#fragment",
		] {
			#expect(throws: ClientError.self) { try attempt.code(from: URL(string: bad)!) }
		}
	}
}
