import Foundation
import MainworthyClient

/// The Mainworthy the tests run against: a real server that `bun scripts/ios.ts test` starts and names in the
/// environment. Run with `swift test` alone, a test that needs it is skipped and says so.
package enum Live {
	private static let environment = ProcessInfo.processInfo.environment

	package static let isRunning = environment["MAINWORTHY_TEST_URL"] != nil

	package static var address: String { environment["MAINWORTHY_TEST_URL"] ?? "" }
	package static var token: String { environment["MAINWORTHY_TEST_TOKEN"] ?? "" }
	package static var name: String { environment["MAINWORTHY_TEST_NAME"] ?? "" }
	package static var password: String { environment["MAINWORTHY_TEST_PASSWORD"] ?? "" }

	package static var instance: Instance {
		guard let instance = Instance(address: address) else { fatalError("MAINWORTHY_TEST_URL is not an address") }
		return instance
	}

	/// A server nobody is signed in to yet, with its secret kept in memory.
	package static func server(secrets: any SecretStore = MemoryStore()) -> Server {
		Server(instance: instance, secrets: secrets, userAgent: "Mainworthy tests")
	}

	/// A server the test's person is signed in to.
	package static func signedIn() async throws -> Server {
		let server = server()
		_ = try await server.signIn(.password(name: name, password: password))
		return server
	}

	/// A project nobody else reads, filled with one of everything the app shows (`scripts/ios/scenario.ts`).
	/// `strict` is a project that holds one run which has passed and waits to be closed.
	package static func project(strict: Bool = false) async throws -> String {
		var request = URLRequest(url: instance.url.appending(path: "/test/project"))
		request.httpMethod = "POST"
		request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.httpBody = Data(#"{"kind":"\#(strict ? "strict" : "standard")"}"#.utf8)
		let (data, _) = try await URLSession.shared.data(for: request)
		struct Reply: Decodable {
			struct Made: Decodable { var project: String }
			var result: Made
		}
		return try JSONDecoder().decode(Reply.self, from: data).result.project
	}
}
