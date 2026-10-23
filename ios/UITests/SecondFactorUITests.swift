import CryptoKit
import XCTest

final class SecondFactorUITests: XCTestCase {
	private let environment = ProcessInfo.processInfo.environment
	private let session = URLSession(configuration: {
		let configuration = URLSessionConfiguration.ephemeral
		configuration.httpShouldSetCookies = false
		return configuration
	}())

	override func setUp() { continueAfterFailure = false }

	private struct Envelope<T: Decodable>: Decodable { let result: T }
	private struct Project: Decodable { let project: String }
	private struct Invitation: Decodable { let code: String }
	private struct SignedIn: Decodable { let signedIn: Bool }
	private struct Enrolment: Decodable { let challenge: String; let secret: String }
	private struct Confirmed: Decodable { let recoveryCodes: [String] }

	@MainActor private func post<T: Decodable>(_ path: String, _ body: [String: Any], cookie: String? = nil, owner: Bool = false) async throws -> (T, HTTPURLResponse) {
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)\(path)")))
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		if owner { request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization") }
		if let cookie { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
		request.httpBody = try JSONSerialization.data(withJSONObject: body)
		let (data, response) = try await session.data(for: request)
		let http = try XCTUnwrap(response as? HTTPURLResponse)
		XCTAssertEqual(http.statusCode, 200)
		return (try JSONDecoder().decode(Envelope<T>.self, from: data).result, http)
	}

	@MainActor func testAuthenticatorAndRecoveryCodesCompletePasswordSignIn() async throws {
		let (project, _): (Project, _) = try await post("/test/project", [:], owner: true)
		let name = "phone-code-\(UUID().uuidString.lowercased())"
		let password = "a password for the phone code test"
		let (invitation, _): (Invitation, _) = try await post("/api/invitation", ["do": "create", "name": name, "project": project.project, "can": ["read"]], owner: true)
		let (joined, response): (SignedIn, _) = try await post("/api/login", ["invitation": invitation.code, "password": password])
		XCTAssertTrue(joined.signedIn)
		let cookie = try XCTUnwrap(response.value(forHTTPHeaderField: "Set-Cookie")?.firstMatch(of: /(?:^|[,\s])(mainworthy_sid=[A-Za-z0-9_-]{43})(?:[;,\s]|$)/)).1
		let (enrolment, _): (Enrolment, _) = try await post("/api/credential", ["do": "totp.begin"], cookie: String(cookie))
		let (confirmed, _): (Confirmed, _) = try await post("/api/credential", ["do": "totp.confirm", "challenge": enrolment.challenge, "code": code(enrolment.secret)], cookie: String(cookie))
		let recovery = try XCTUnwrap(confirmed.recoveryCodes.first)

		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		signIn(app, name: name, password: password)
		let field = app.textFields["sign-in-code"]
		XCTAssertTrue(field.waitForExistence(timeout: 10))
		XCTAssertFalse(app.secureTextFields["password"].exists)
		XCTAssertEqual(app.buttons["sign-in"].label, "Verify code")
		shot("second-factor-code")
		field.tap()
		field.typeText("wrong")
		app.buttons["sign-in"].tap()
		let notice = app.staticTexts["sign-in-notice"]
		XCTAssertTrue(notice.waitForExistence(timeout: 10))
		XCTAssertEqual(notice.label, "That code did not sign you in. Use a new authenticator code or an unused recovery code.")
		shot("second-factor-refused")
		field.tap()
		field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5) + code(enrolment.secret, next: true))
		app.buttons["sign-in"].tap()
		XCTAssertTrue(app.navigationBars["Queue"].waitForExistence(timeout: 20))
		shot("second-factor-signed-in")
		app.terminate()
		app.launch()
		signIn(app, name: name, password: password)
		XCTAssertTrue(field.waitForExistence(timeout: 10))
		app.buttons["sign-in-start-again"].tap()
		XCTAssertTrue(app.secureTextFields["password"].waitForExistence(timeout: 5))
		XCTAssertFalse(field.exists)
		app.secureTextFields["password"].tap()
		app.secureTextFields["password"].typeText(password)
		app.buttons["sign-in"].tap()
		XCTAssertTrue(field.waitForExistence(timeout: 10))
		field.tap()
		field.typeText(recovery)
		app.buttons["sign-in"].tap()
		XCTAssertTrue(app.navigationBars["Queue"].waitForExistence(timeout: 20))
		shot("second-factor-recovery-signed-in")
	}

	@MainActor private func signIn(_ app: XCUIApplication, name: String, password: String) {
		XCTAssertTrue(app.textFields["name"].waitForExistence(timeout: 20))
		app.textFields["name"].tap()
		app.textFields["name"].typeText(name)
		app.secureTextFields["password"].tap()
		app.secureTextFields["password"].typeText(password)
		app.buttons["sign-in"].tap()
	}

	private func code(_ secret: String, next: Bool = false) -> String {
		let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
		var value: UInt32 = 0
		var bits = 0
		var key = Data()
		for character in secret {
			value = (value << 5) | UInt32(alphabet.firstIndex(of: character)!)
			bits += 5
			if bits >= 8 { bits -= 8; key.append(UInt8(truncatingIfNeeded: value >> bits)) }
		}
		var counter = (UInt64(Date().timeIntervalSince1970 / 30) + (next ? 1 : 0)).bigEndian
		let bytes = withUnsafeBytes(of: &counter) { Data($0) }
		let digest = Array(HMAC<Insecure.SHA1>.authenticationCode(for: bytes, using: SymmetricKey(data: key)))
		let offset = Int(digest.last! & 15)
		let truncated = digest[offset..<(offset + 4)].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) } & 0x7fffffff
		return String(format: "%06u", truncated % 1_000_000)
	}

	@MainActor private func shot(_ name: String) {
		guard let directory = environment["MAINWORTHY_SCREENSHOTS"] else { return }
		try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
	}
}
