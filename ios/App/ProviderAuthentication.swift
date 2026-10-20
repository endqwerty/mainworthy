import AuthenticationServices
import SwiftUI

@MainActor
final class ProviderAuthentication: NSObject, ASWebAuthenticationPresentationContextProviding {
	private var attempt: UUID?
	private var session: ASWebAuthenticationSession?
	private var completion: ((Result<URL, Error>) -> Void)?

	func authenticate(url: URL, scheme: String) async throws -> URL {
		try await withTaskCancellationHandler {
			try Task.checkCancellation()
			return try await withCheckedThrowingContinuation { continuation in
				let id = UUID()
				attempt = id
				completion = { continuation.resume(with: $0) }
				let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { url, error in
					Task { @MainActor in
						if let url { self.finish(.success(url), id: id) }
						else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
							self.finish(.failure(CancellationError()), id: id)
						} else { self.finish(.failure(error ?? URLError(.badServerResponse)), id: id) }
					}
				}
				session.presentationContextProvider = self
				self.session = session
				if !session.start() {
					finish(.failure(URLError(.cannotLoadFromNetwork)), id: id)
				}
			}
		} onCancel: {
			Task { @MainActor in self.cancel() }
		}
	}

	func cancel() {
		guard let id = attempt else { return }
		session?.cancel()
		finish(.failure(CancellationError()), id: id)
	}

	private func finish(_ result: Result<URL, Error>, id: UUID) {
		guard attempt == id else { return }
		attempt = nil
		let complete = completion
		completion = nil
		session = nil
		complete?(result)
	}

	func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
		UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
			.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
	}
}
