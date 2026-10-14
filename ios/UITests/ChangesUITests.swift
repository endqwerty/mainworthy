import XCTest

final class ChangesUITests: XCTestCase {
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
			struct Made: Decodable { let project: String }
			let result: Made
		}
		return try JSONDecoder().decode(Reply.self, from: data).result.project
	}

	@MainActor private func shot(_ name: String) {
		guard let directory = environment["MAINWORTHY_SCREENSHOTS"] else { return }
		try? XCUIScreen.main.screenshot().pngRepresentation.write(
			to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png")
		)
	}

	@MainActor private func signIn(_ app: XCUIApplication) throws {
		let address = app.textFields["address"]
		XCTAssertTrue(address.waitForExistence(timeout: 20))
		address.replaceText(try XCTUnwrap(environment["MAINWORTHY_TEST_URL"]))
		app.textFields["name"].tap()
		app.textFields["name"].typeText(environment["MAINWORTHY_TEST_NAME"] ?? "")
		app.secureTextFields["password"].tap()
		app.secureTextFields["password"].typeText(environment["MAINWORTHY_TEST_PASSWORD"] ?? "")
		app.buttons["sign-in"].tap()
		XCTAssertTrue(app.navigationBars["Queue"].waitForExistence(timeout: 20))
	}

	@MainActor func testAChangeUnblocksAndThisDevicesSessionIsMarked() async throws {
		let project = try await makeProject()
		let app = XCUIApplication()
		app.launchArguments = ["-forget"]
		app.launch()
		try signIn(app)
		app.buttons["project-menu"].tap()
		app.buttons[project].tap()
		XCTAssertTrue(app.staticTexts["expected $90.00, got $100.00"].waitForExistence(timeout: 10))
		app.tabBars.buttons["Changes"].tap()
		let row = app.buttons["change-pr:482"]
		XCTAssertTrue(row.waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["Apply a percentage coupon"].exists)
		XCTAssertTrue(app.staticTexts["blocked"].exists)
		shot("changes-list")
		row.tap()
		let verdict = app.staticTexts["change-verdict"]
		XCTAssertTrue(verdict.waitForExistence(timeout: 10))
		XCTAssertEqual(verdict.label, "blocked")
		XCTAssertTrue(app.staticTexts["change-reason"].label.hasPrefix("blocked:"))
		shot("change-blocked")
		let failed = app.staticTexts["Shop check 1"]
		if !failed.isHittable { app.swipeUp() }
		XCTAssertTrue(failed.waitForExistence(timeout: 5))
		XCTAssertTrue(app.staticTexts["expected $90.00, got $100.00"].exists)
		shot("change-failing-tests")
		app.swipeDown()
		let question = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "change-question-")).allElementsBoundByIndex
		let failure = try XCTUnwrap(question.first { $0.label.contains("expected $90.00") })
		failure.tap()
		XCTAssertTrue(app.staticTexts["Expected"].waitForExistence(timeout: 10))
		app.buttons["answer-flaky"].tap()
		XCTAssertTrue(verdict.waitForExistence(timeout: 10))
		let passed = NSPredicate(format: "label == %@", "passed")
		let changed = expectation(for: passed, evaluatedWith: verdict)
		let result = await XCTWaiter.fulfillment(of: [changed], timeout: 10)
		XCTAssertEqual(result, .completed)
		shot("change-passed")
		app.tabBars.buttons["You"].tap()
		app.buttons["Your sessions"].tap()
		XCTAssertTrue(app.staticTexts["current-session"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Mainworthy for iPhone")).firstMatch.exists)
		shot("sessions-list")
	}
}
