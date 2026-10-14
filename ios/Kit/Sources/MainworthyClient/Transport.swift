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
		session = URLSession(configuration: configuration)
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
