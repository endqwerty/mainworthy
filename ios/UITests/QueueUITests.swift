import XCTest

/// A project of a test's own, filled by `scripts/ios/scenario.ts`. Its key is also its name.
private func makeProject() async throws -> String {
	let environment = ProcessInfo.processInfo.environment
	let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"], "run this with `bun scripts/ios.ts uitest`")
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

/// The app in a simulator, against the Mainworthy `bun scripts/ios.ts uitest` starts: a person signs in and
/// works the queue through the screens, as on a phone.
final class QueueUITests: XCTestCase {
	private let environment = ProcessInfo.processInfo.environment

	override func setUp() {
		continueAfterFailure = false
	}

	/// Keeps a picture of the screen where the script that ran the test says, for a person to look at.
	@MainActor private func shot(_ name: String) {
		guard let directory = environment["MAINWORTHY_SCREENSHOTS"] else { return }
		let file = URL(fileURLWithPath: directory).appendingPathComponent("\(name).png")
		try? XCUIScreen.main.screenshot().pngRepresentation.write(to: file)
	}

	@MainActor private func signIn(_ app: XCUIApplication) throws {
		let address = app.textFields["address"]
		XCTAssertTrue(address.waitForExistence(timeout: 20))
		// A device that has signed in nowhere offers the hosted instance, and asks for no token.
		XCTAssertEqual(address.value as? String, "mainworthy.com")
		XCTAssertFalse(app.secureTextFields["token"].exists || app.buttons["Token"].exists)
		address.replaceText(try XCTUnwrap(environment["MAINWORTHY_TEST_URL"]))
		app.textFields["name"].tap()
		app.textFields["name"].typeText(environment["MAINWORTHY_TEST_NAME"] ?? "")
		app.secureTextFields["password"].tap()
		app.secureTextFields["password"].typeText(environment["MAINWORTHY_TEST_PASSWORD"] ?? "")
		shot("1-sign-in")
		app.buttons["sign-in"].tap()
		XCTAssertTrue(app.navigationBars["Queue"].waitForExistence(timeout: 20))
	}

	@MainActor func testAPersonSignsInAnswersAQuestionAndTakesItBack() async throws {
		let project = try await makeProject()
		let app = XCUIApplication()
		app.launchArguments = ["-forget"]
		app.launch()
		try signIn(app)

		// The instance's first project is empty. The test's own is opened from the menu.
		app.buttons["project-menu"].tap()
		app.buttons[project].tap()
		let failure = app.staticTexts["expected $90.00, got $100.00"]
		XCTAssertTrue(failure.waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["1 failure to explain · 3 can wait"].exists)
		shot("2-queue")

		// The question is answered from its own page, where its evidence is.
		failure.tap()
		XCTAssertTrue(app.staticTexts["Expected"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.staticTexts["$90.00"].exists && app.staticTexts["$100.00"].exists)
		shot("3-failure")
		app.buttons["answer-flaky"].tap()

		// Back in the list: the question is gone, and the screen says what was recorded.
		let notice = app.staticTexts["notice"]
		XCTAssertTrue(notice.waitForExistence(timeout: 10))
		XCTAssertTrue(notice.label.hasSuffix(": Flaky."), notice.label)
		XCTAssertFalse(failure.exists)
		shot("4-answered")

		app.buttons["Undo"].tap()
		XCTAssertTrue(failure.waitForExistence(timeout: 10))
		XCTAssertTrue(notice.label.hasSuffix("the decision is withdrawn."), notice.label)

		// An agent's edit is shown as what it changes, before anybody accepts it.
		app.staticTexts["Edit: A percentage coupon lowers the total"].tap()
		XCTAssertTrue(app.staticTexts["Remove the coupon\n> Total returns to $100.00"].waitForExistence(timeout: 10))
		shot("5-proposal")
		app.buttons["answer-reject"].tap()
		XCTAssertTrue(notice.waitForExistence(timeout: 10))
		XCTAssertTrue(notice.label.hasSuffix(": Reject."), notice.label)

		// What was decided, and by whom.
		app.buttons["Decided"].tap()
		XCTAssertTrue(app.staticTexts["Reject · \(environment["MAINWORTHY_TEST_NAME"] ?? "")"].waitForExistence(timeout: 10))
		shot("6-decided")

		app.tabBars.buttons["You"].tap()
		XCTAssertTrue(app.staticTexts["Signed in"].waitForExistence(timeout: 5))
		shot("7-you")
		// Signing out is the last row of a list that grows with the app: it is scrolled to.
		if !app.buttons["sign-out"].waitForExistence(timeout: 2) { app.swipeUp() }
		XCTAssertTrue(app.buttons["sign-out"].waitForExistence(timeout: 5))
		app.buttons["sign-out"].tap()
		app.buttons["Sign out"].firstMatch.tap()
		XCTAssertTrue(app.textFields["address"].waitForExistence(timeout: 10))
	}
}
