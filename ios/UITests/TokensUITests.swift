import XCTest

final class TokensUITests: XCTestCase {
	private let environment = ProcessInfo.processInfo.environment

	override func setUp() { continueAfterFailure = false }

	@MainActor private func shot(_ name: String) {
		guard let directory = environment["MAINWORTHY_SCREENSHOTS"] else { return }
		try? XCUIScreen.main.screenshot().pngRepresentation.write(
			to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png")
		)
	}

	@MainActor func testListConfirmAndRevokeToken() async throws {
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)/api/admin")))
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
		let actor = "phone-\(UUID().uuidString.lowercased())"
		request.httpBody = try JSONSerialization.data(withJSONObject: [
			"do": "token.create", "actor": actor, "kind": "ci",
			"label": "Phone revoke check", "can": ["read"],
		])
		let (_, created) = try await URLSession.shared.data(for: request)
		XCTAssertEqual((created as? HTTPURLResponse)?.statusCode, 200)
		request.httpBody = Data(#"{"do":"token.list"}"#.utf8)
		let (data, _) = try await URLSession.shared.data(for: request)
		struct Reply: Decodable { struct Row: Decodable { let id: Int; let actor: String }; let result: [Row] }
		let id = try XCTUnwrap(try JSONDecoder().decode(Reply.self, from: data).result.first { $0.actor == actor }).id
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", address]
		app.launch()
		XCTAssertTrue(app.textFields["name"].waitForExistence(timeout: 20))
		app.textFields["name"].tap()
		app.textFields["name"].typeText(environment["MAINWORTHY_TEST_OWNER_NAME"] ?? "")
		app.secureTextFields["password"].tap()
		app.secureTextFields["password"].typeText(environment["MAINWORTHY_TEST_OWNER_PASSWORD"] ?? "")
		app.buttons["sign-in"].tap()
		XCTAssertTrue(app.navigationBars["Queue"].waitForExistence(timeout: 20))
		app.tabBars.buttons["You"].tap()
		XCTAssertTrue(app.buttons["Tokens"].waitForExistence(timeout: 5))
		app.buttons["Tokens"].tap()
		let revoke = app.buttons["revoke-token-\(id)"]
		XCTAssertTrue(revoke.waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["Phone revoke check"].exists)
		shot("tokens-list")
		revoke.tap()
		XCTAssertTrue(app.staticTexts["Revoke \"Phone revoke check\" (#\(id))?"].waitForExistence(timeout: 5))
		shot("tokens-confirmation")
		app.buttons["Revoke token"].tap()
		let notice = app.staticTexts["tokens-notice"]
		XCTAssertTrue(notice.waitForExistence(timeout: 10))
		XCTAssertEqual(notice.label, "Revoked \"Phone revoke check\" (#\(id)).")
		let state = app.staticTexts["token-state-\(id)"]
		let revoked = expectation(for: NSPredicate(format: "label == %@", "Revoked"), evaluatedWith: state)
		let result = await XCTWaiter.fulfillment(of: [revoked], timeout: 10)
		XCTAssertEqual(result, .completed)
	}
}
