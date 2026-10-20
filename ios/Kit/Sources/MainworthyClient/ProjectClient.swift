import Foundation

extension Server {
	/// One project of this server.
	package func project(_ key: String, identity: String) -> ProjectClient {
		ProjectClient(server: self, key: key, identity: identity)
	}
}

/// What can be asked of one project. Each part of the product adds its functions in a file of its own
/// (`Queue.swift`), one for each thing a person does, whole: it sends what the operation takes and says what
/// came of it in the app's own words.
package struct ProjectClient: Sendable {
	let server: Server
	package let key: String
	package let identity: String

	init(server: Server, key: String, identity: String) {
		self.server = server
		self.key = key
		self.identity = identity
	}

	/// What changes in the project, as it happens (`Server.changes`).
	package func changes() -> AsyncThrowingStream<Change, any Error> {
		server.changes(in: key)
	}
}
