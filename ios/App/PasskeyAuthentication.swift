import AuthenticationServices
import MainworthyClient
import SwiftUI

@MainActor
final class PasskeyAuthentication: NSObject, PasskeyAuthorizing, ASAuthorizationControllerDelegate,
	ASAuthorizationControllerPresentationContextProviding
{
	private var controller: ASAuthorizationController?
	private var completion: ((Result<PasskeyAssertion, Error>) -> Void)?

	func authorize(_ request: PasskeyRequest) async throws -> PasskeyAssertion {
		try await withTaskCancellationHandler {
			try Task.checkCancellation()
			return try await withCheckedThrowingContinuation { continuation in
				let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: request.relyingParty)
				let assertion = provider.createCredentialAssertionRequest(challenge: request.challenge)
				assertion.userVerificationPreference = .required
				let controller = ASAuthorizationController(authorizationRequests: [assertion])
				controller.delegate = self
				controller.presentationContextProvider = self
				self.controller = controller
				completion = { continuation.resume(with: $0) }
				controller.performRequests()
			}
		} onCancel: {
			Task { @MainActor in self.cancel() }
		}
	}

	func cancel() {
		guard let controller else { return }
		finish(.failure(CancellationError()), controller: controller)
		controller.cancel()
	}

	func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
		guard let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
			finish(.failure(PasskeyAuthorizationError.unavailable), controller: controller)
			return
		}
		finish(.success(PasskeyAssertion(
			credentialID: assertion.credentialID, clientDataJSON: assertion.rawClientDataJSON,
			authenticatorData: assertion.rawAuthenticatorData, signature: assertion.signature, userID: assertion.userID
		)), controller: controller)
	}

	func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
		if (error as? ASAuthorizationError)?.code == .canceled {
			finish(.failure(CancellationError()), controller: controller)
		} else {
			finish(.failure(PasskeyAuthorizationError.unavailable), controller: controller)
		}
	}

	private func finish(_ result: Result<PasskeyAssertion, Error>, controller: ASAuthorizationController) {
		guard self.controller === controller else { return }
		self.controller = nil
		let complete = completion
		completion = nil
		complete?(result)
	}

	func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
		UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
			.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
	}
}
