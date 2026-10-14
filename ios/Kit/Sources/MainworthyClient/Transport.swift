import Foundation

/// How a request leaves the device. The app has one way, `URLSessionTransport`; a test puts its own in its
/// place to lose a reply or to answer without a network.
package protocol Transport: Sendable {
	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
	/// A reply that does not end: its lines as they arrive.
	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse)
}

package struct URLSessionTransport: Transport {
	private let session: URLSession

	package init() {
		// The session cookie is kept by `Server`, in the keychain, and sent by hand: the system's cookie store
		// would keep a second copy in a file, and would send it to whatever else shares the store.
		let configuration = URLSessionConfiguration.ephemeral
		configuration.httpCookieStorage = nil
		configuration.httpShouldSetCookies = false
		configuration.urlCache = nil
		// Between two bytes, not for the whole reply. The change stream says something every 20 seconds.
		configuration.timeoutIntervalForRequest = 45
		session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
	}

	/// A redirect is not followed. The cookie is set on every request by hand, so the system would carry it to
	/// wherever a reply pointed, and a Mainworthy answers its operations where it is asked. The redirect itself
	/// comes back as the reply, which is no envelope, and is said to be unreadable.
	private final class NoRedirects: NSObject, URLSessionTaskDelegate {
		func urlSession(
			_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
			newRequest request: URLRequest
		) async -> URLRequest? {
			nil
		}
	}

	package func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let (data, response) = try await session.data(for: request)
		guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
		return (data, http)
	}

	package func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		let (bytes, response) = try await session.bytes(for: request)
		guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
		let stream = AsyncThrowingStream<String, any Error> { continuation in
			let reading = Task {
				do {
					for try await line in bytes.lines { continuation.yield(line) }
					continuation.finish()
				} catch {
					continuation.finish(throwing: error)
				}
			}
			continuation.onTermination = { _ in reading.cancel() }
		}
		return (stream, http)
	}
}
