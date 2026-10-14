import Foundation
import TestSupport
import Testing

@testable import MainworthyClient

@Suite("Sessions against the server", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
struct SessionsLiveTests {
	@Test("a password and a token open labelled sessions, and ending another leaves this device signed in")
	func listAndEnd() async throws {
		let own = try await Live.signedIn()
		let other = Live.server()
		_ = try await other.signIn(.token(Live.token))
		let others = try await other.sessions()
		let theirs = try #require(others.first { $0.current })
		#expect(theirs.proof == .token && !theirs.label.isEmpty)
		let mine = try #require(try await own.sessions().first { $0.current })
		#expect(mine.proof == .password && mine.label == "password")
		#expect(mine.client == "Mainworthy tests" && mine.openedAt <= mine.lastUsedAt)
		#expect(try await own.end(theirs) == .ended)
		#expect(try await own.end(theirs) == .alreadyEnded)
		#expect(try await own.account().name == Live.name)
		await #expect(throws: ClientError.signedOut) { _ = try await other.account() }
		await own.signOut()
	}

	@Test("the reply identifies ending the current session")
	func endOwn() async throws {
		let own = try await Live.signedIn()
		let mine = try #require(try await own.sessions().first { $0.current })
		#expect(try await own.end(mine) == .signedOut)
		await #expect(throws: ClientError.signedOut) { _ = try await own.account() }
	}
}

@Suite("Session client names")
struct BrowserNameTests {
	@Test("the same browsers and platforms as the web fixtures")
	func webCases() {
		let cases = [
			(
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
				"Chrome/141.0.0.0 Safari/537.36",
				"Chrome on Linux"
			),
			(
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
				"HeadlessChrome/141.0.0.0 Safari/537.36",
				"Chrome on Linux"
			),
			(
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
				"Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
				"Edge on Windows"
			),
			(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like " +
				"Gecko) Version/18.5 Safari/605.1.15",
				"Safari on macOS"
			),
			("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0", "Firefox on Linux"),
			(
				"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, " +
				"like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
				"Safari on iOS"
			),
			(
				"Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) " +
				"Chrome/141.0.0.0 Mobile Safari/537.36",
				"Chrome on Android"
			),
		]
		for (agent, expected) in cases { #expect(browserName(agent) == expected) }
		#expect(SessionProof("future") == .other("future") && SessionProof("future").name == "future")
		#expect(browserName("curl/8.14.1") == "curl/8.14.1")
		#expect(browserName(String(repeating: "x", count: 200)) == String(repeating: "x", count: 60) + "…")
		#expect(browserName(nil) == "Unknown browser" && browserName("") == "Unknown browser")
		#expect(browserName("Mainworthy for iPhone 1.0") == "Mainworthy for iPhone 1.0")
		#expect(browserName("Chrome/1 OPR/2 (Android Linux)") == "Opera on Android")
		#expect(browserName("CriOS/1 (iPad like Mac OS X)") == "Chrome on iOS")
		#expect(browserName("FxiOS/1 (iPod)") == "Firefox on iOS")
	}
}
