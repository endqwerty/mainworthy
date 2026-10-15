import XCTest

final class SuiteUITests: XCTestCase {
	private let environment = ProcessInfo.processInfo.environment

	override func setUp() { continueAfterFailure = false }

	@MainActor private func makeProject() async throws -> String {
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)/test/project")))
		request.httpMethod = "POST"
		request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
		request.httpBody = Data("{}".utf8)
		let (data, _) = try await URLSession.shared.data(for: request)
		struct Reply: Decodable {
			struct Made: Decodable { var project: String }
			var result: Made
		}
		return try JSONDecoder().decode(Reply.self, from: data).result.project
	}

	@MainActor private func shot(_ name: String) {
		guard let directory = environment["MAINWORTHY_SCREENSHOTS"] else { return }
		try? XCUIScreen.main.screenshot().pngRepresentation.write(
			to: URL(fileURLWithPath: directory).appendingPathComponent("suite-\(name).png"))
	}

	@MainActor private func signIn(_ app: XCUIApplication) throws {
		XCTAssertTrue(app.textFields["name"].waitForExistence(timeout: 20))
		app.textFields["name"].tap()
		app.textFields["name"].typeText(environment["MAINWORTHY_TEST_NAME"] ?? "")
		app.secureTextFields["password"].tap()
		app.secureTextFields["password"].typeText(environment["MAINWORTHY_TEST_PASSWORD"] ?? "")
		app.buttons["sign-in"].tap()
		XCTAssertTrue(app.navigationBars["Queue"].waitForExistence(timeout: 20))
	}

	@MainActor private func addStep(_ app: XCUIApplication, action: String, expected: String) {
		app.buttons["editor-add-step"].tap()
		let actions = app.textFields.matching(NSPredicate(format: "identifier BEGINSWITH 'editor-action-'"))
		let results = app.textFields.matching(NSPredicate(format: "identifier BEGINSWITH 'editor-expected-'"))
		let field = actions.element(boundBy: actions.count - 1)
		field.tap()
		field.typeText(action)
		let result = results.element(boundBy: results.count - 1)
		result.tap()
		result.typeText(expected)
	}

	/// The system's back gesture: a drag that starts at the left edge of the screen.
	@MainActor private func swipeBack(_ app: XCUIApplication) {
		let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.0, dy: 0.5))
		edge.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)))
	}

	@MainActor func testBrowseCreateEditAndHistory() async throws {
		XCUIDevice.shared.orientation = .portrait
		let project = try await makeProject()
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)
		app.buttons["project-menu"].tap()
		app.buttons[project].tap()
		app.tabBars.buttons["Cases"].tap()
		XCTAssertTrue(app.buttons["folder-Checkout"].waitForExistence(timeout: 10))
		shot("folders")
		app.buttons["folder-Checkout"].tap()
		XCTAssertTrue(app.navigationBars["Checkout"].waitForExistence(timeout: 5))
		app.buttons["folder-Checkout/Coupons"].tap()
		let expired = app.staticTexts["Expired coupon is rejected"]
		XCTAssertTrue(expired.waitForExistence(timeout: 10))
		shot("folder")
		expired.tap()
		XCTAssertTrue(app.staticTexts["2. Apply the coupon OLD10"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["Error \"Coupon expired\"; total unchanged"].exists)
		shot("case")
		// Back, as in Files: a swipe from the left edge, twice, to the folder above.
		swipeBack(app)
		XCTAssertTrue(app.navigationBars["Coupons"].waitForExistence(timeout: 5))
		swipeBack(app)
		XCTAssertTrue(app.navigationBars["Checkout"].waitForExistence(timeout: 5))
		// A folder opened again shows its cases from what was read, with no spinner.
		app.buttons["folder-Checkout/Coupons"].tap()
		XCTAssertTrue(expired.waitForExistence(timeout: 2))
		XCTAssertFalse(app.activityIndicators.firstMatch.exists)
		// The magnifier searches the folder it was opened in, or everywhere.
		app.buttons["suite-search"].tap()
		let search = app.searchFields.firstMatch
		XCTAssertTrue(search.waitForExistence(timeout: 5))
		search.typeText("expired")
		XCTAssertTrue(expired.waitForExistence(timeout: 10))
		shot("search")
		search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 7) + "password")
		XCTAssertTrue(app.staticTexts["No Results for \u{201C}password\u{201D}"].waitForExistence(timeout: 10))
		app.buttons["Everywhere"].tap()
		XCTAssertTrue(app.staticTexts["Password reset restores access"].waitForExistence(timeout: 10))
		XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'suite-case-'")).count, 1)
		// A result opens over the search, and going back finds the search as it was.
		app.staticTexts["Password reset restores access"].tap()
		XCTAssertTrue(app.staticTexts["case-version"].waitForExistence(timeout: 10))
		swipeBack(app)
		XCTAssertTrue(app.staticTexts["Password reset restores access"].waitForExistence(timeout: 5))
		XCTAssertEqual(search.value as? String, "password")
		// Closing the search goes back to the folder, and the next search starts empty.
		app.buttons["Close"].tap()
		XCTAssertTrue(app.buttons["suite-search"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.navigationBars["Coupons"].exists)
		app.buttons["suite-search"].tap()
		XCTAssertTrue(search.waitForExistence(timeout: 5))
		XCTAssertNotEqual(search.value as? String, "password")
		app.buttons["Close"].tap()
		XCTAssertTrue(app.buttons["suite-search"].waitForExistence(timeout: 5))
		// A tag is browsed from the top of the tab.
		swipeBack(app)
		swipeBack(app)
		XCTAssertTrue(app.buttons["tag-regression"].waitForExistence(timeout: 5))
		app.buttons["tag-regression"].tap()
		XCTAssertTrue(app.navigationBars["#regression"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'suite-case-'")).element(boundBy: 2)
			.waitForExistence(timeout: 10))
		XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'suite-case-'")).count, 3)
		shot("tag")
		swipeBack(app)
		app.buttons["folder-Checkout"].tap()
		app.buttons["folder-Checkout/Coupons"].tap()
		app.buttons["suite-new"].tap()
		let title = app.textFields["editor-title"]
		XCTAssertTrue(title.waitForExistence(timeout: 5))
		title.tap()
		title.typeText(String(repeating: "x", count: 301))
		XCTAssertFalse(app.buttons["editor-save"].isEnabled)
		XCTAssertTrue(app.staticTexts["301/300 UTF-16 units"].exists)
		shot("title-limit")
		title.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 301))
		title.typeText("Coupon can be removed")
		addStep(app, action: "Apply SAVE10", expected: "Total is lower")
		addStep(app, action: "Remove SAVE10", expected: "Total returns")
		app.swipeDown()
		shot("editor")
		app.buttons["editor-cancel"].tap()
		XCTAssertTrue(app.buttons["Discard"].waitForExistence(timeout: 5))
		app.buttons["Keep editing"].tap()
		// The draft remains after the app goes to the background.
		XCUIDevice.shared.press(.home)
		app.activate()
		XCTAssertEqual(app.textFields["editor-title"].value as? String, "Coupon can be removed")
		app.buttons["editor-save"].tap()
		XCTAssertTrue(app.staticTexts["case-version"].waitForExistence(timeout: 15))
		XCTAssertEqual(app.staticTexts["case-version"].label, "Version 1")
		XCTAssertTrue(app.staticTexts["Checkout/Coupons"].exists)
		XCTAssertFalse(app.buttons["case-edit"].exists)
		app.buttons["case-current"].tap()
		XCTAssertTrue(app.buttons["case-edit"].waitForExistence(timeout: 10))
		app.buttons["case-edit"].tap()
		XCTAssertTrue(title.waitForExistence(timeout: 10))
		let pre = app.textFields["editor-pre"]
		pre.tap()
		pre.typeText("Start with an empty cart")
		addStep(app, action: "Reload the cart", expected: "The coupon stays removed")
		XCTAssertTrue(app.buttons["editor-save"].isEnabled)
		app.buttons["editor-save"].tap()
		let savedVersion = app.staticTexts["case-version"]
		XCTAssertTrue(savedVersion.wait(for: \.label, toEqual: "Version 2", timeout: 15))
		app.buttons["case-history"].tap()
		XCTAssertTrue(app.buttons["history-version-1"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.buttons["history-version-2"].exists)
		shot("history")
		app.buttons["history-version-1"].tap()
		XCTAssertTrue(app.staticTexts["Coupon can be removed"].waitForExistence(timeout: 10))
		XCTAssertEqual(app.staticTexts["case-version"].label, "Version 1")
		XCTAssertFalse(app.buttons["case-edit"].exists)
	}
}
