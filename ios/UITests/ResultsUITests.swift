import XCTest

/// The results a change's gate counted, the tests with and without a case, and what a case's row and page say
/// about who ran it and who may.
final class ResultsUITests: XCTestCase {
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
		XCTAssertTrue(app.textFields["name"].waitForExistence(timeout: 20))
		app.textFields["name"].tap()
		app.textFields["name"].typeText(environment["MAINWORTHY_TEST_NAME"] ?? "")
		app.secureTextFields["password"].tap()
		app.secureTextFields["password"].typeText(environment["MAINWORTHY_TEST_PASSWORD"] ?? "")
		app.buttons["sign-in"].tap()
		XCTAssertTrue(app.navigationBars["Queue"].waitForExistence(timeout: 20))
	}

	@MainActor private func scrollTo(_ element: XCUIElement, in app: XCUIApplication) {
		for _ in 0..<6 where !(element.exists && element.isHittable) { app.swipeUp() }
		XCTAssertTrue(element.waitForExistence(timeout: 5))
	}

	@MainActor func testResultsTestsAndWhoRanACase() async throws {
		XCUIDevice.shared.orientation = .portrait
		let project = try await makeProject()
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)
		app.buttons["project-menu"].tap()
		app.buttons[project].tap()
		XCTAssertTrue(app.staticTexts["expected $90.00, got $100.00"].waitForExistence(timeout: 10))

		// The change's results: every test its gate counted, the one with no case among them.
		app.tabBars.buttons["Changes"].tap()
		app.buttons["change-pr:482"].tap()
		XCTAssertTrue(app.staticTexts["change-verdict"].waitForExistence(timeout: 10))
		let all = app.buttons["results-all"]
		scrollTo(all, in: app)
		XCTAssertEqual(all.label, "All 5")
		let tracked = app.buttons["result-T-5"]
		XCTAssertTrue(tracked.exists)
		XCTAssertTrue(tracked.label.contains("no case") && tracked.label.contains("Shipping accepts an address"), tracked.label)
		shot("results-all")
		app.buttons["results-unexplained"].tap()
		let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: tracked)
		XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 10), .completed)
		XCTAssertTrue(app.buttons["result-T-1"].exists)
		XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'result-question-Q-'")).firstMatch.exists)
		shot("results-unexplained")
		all.tap()
		scrollTo(tracked, in: app)
		tracked.tap()
		let none = app.staticTexts["test-case"]
		XCTAssertTrue(none.waitForExistence(timeout: 10))
		XCTAssertTrue(none.label.hasPrefix("None: the test is tracked without a case."))
		XCTAssertTrue(app.staticTexts["tests/shipping.spec.ts::shipping::address"].exists)
		shot("result-test")

		// The Tests list, and only the tests with no case.
		app.tabBars.buttons["Cases"].tap()
		app.buttons["suite-tests"].tap()
		XCTAssertTrue(app.buttons["test-T-1"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.buttons["test-T-5"].exists)
		shot("tests")
		app.switches["tests-unlinked"].switches.firstMatch.tap()
		let linked = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["test-T-1"])
		XCTAssertEqual(XCTWaiter.wait(for: [linked], timeout: 10), .completed)
		XCTAssertTrue(app.buttons["test-T-5"].exists)
		shot("tests-unlinked")

		// A row of the list opens its test, here as from a change's results.
		app.buttons["test-T-5"].tap()
		let left = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.switches["tests-unlinked"])
		XCTAssertEqual(XCTWaiter.wait(for: [left], timeout: 10), .completed)
		let page = app.staticTexts["test-case"]
		XCTAssertTrue(page.waitForExistence(timeout: 10))
		XCTAssertTrue(page.label.hasPrefix("None: the test is tracked without a case."))
		shot("tests-test")
		app.navigationBars.buttons.element(boundBy: 0).tap()
		XCTAssertTrue(app.switches["tests-unlinked"].waitForExistence(timeout: 10))
		app.navigationBars.buttons.element(boundBy: 0).tap()

		// A case's row says who ran it and what came of it; its page, who may run it.
		XCTAssertTrue(app.buttons["folder-Checkout"].waitForExistence(timeout: 10))
		app.buttons["folder-Checkout"].tap()
		app.buttons["folder-Checkout/Coupons"].tap()
		let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Expired coupon is rejected'")).firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 10))
		XCTAssertTrue(row.label.contains("Pipeline: failed"), row.label)
		shot("case-row-proof")
		row.tap()
		let person = app.descendants(matching: .any)["method-human"]
		scrollTo(person, in: app)
		XCTAssertEqual(person.label, "A person may run it")
		XCTAssertEqual(app.descendants(matching: .any)["method-auto"].label, "A pipeline may run it")
		shot("case-who-may-run")
	}
}
