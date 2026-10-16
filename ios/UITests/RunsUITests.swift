import XCTest

final class RunsUITests: XCTestCase {
	private let environment = ProcessInfo.processInfo.environment
	override func setUp() { continueAfterFailure = false }

	@MainActor private func makeProject() async throws -> String {
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)/test/project")))
		request.httpMethod = "POST"
		request.setValue(
			"Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
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
			to: URL(fileURLWithPath: directory).appendingPathComponent("runs-\(name).png"))
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

	@MainActor func testExecuteAndPlanARun() async throws {
		let project = try await makeProject()
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)
		app.buttons["project-menu"].tap()
		app.buttons[project].tap()
		app.tabBars.buttons["Runs"].tap()
		let regression = app.staticTexts["Checkout regression"]
		XCTAssertTrue(regression.waitForExistence(timeout: 15))
		shot("1-list")
		regression.tap()
		let start = app.buttons["start-run"]
		XCTAssertTrue(start.waitForExistence(timeout: 10))
		shot("2-run")
		// The pipeline filled the first four slots: each is left to that result, so its row does not open, and the
		// list says why. The fifth, which nobody filled, opens.
		XCTAssertFalse(app.buttons["run-slot-1"].exists)
		app.swipeUp()
		XCTAssertTrue(app.buttons["run-slot-5"].waitForExistence(timeout: 5))
		XCTAssertFalse(app.buttons["run-slot-4"].exists)
		shot("2b-left-to-others")
		XCTAssertTrue(
			app.staticTexts[
				"A slot that a pipeline, an agent or another person filled, and you have not, is left to that result and does not open."
			].waitForExistence(timeout: 5))
		app.swipeDown()
		start.tap()
		let title = app.staticTexts["executing-case"]
		XCTAssertTrue(title.waitForExistence(timeout: 10))
		XCTAssertEqual(title.label, "Order total includes shipping")
		app.buttons["record-pass"].tap()
		XCTAssertTrue(app.staticTexts["Catalog keeps the selected filters"].waitForExistence(timeout: 10))
		app.buttons["run-step-1"].tap()
		XCTAssertTrue(app.staticTexts["Failed step"].exists)
		shot("3-marked-step")
		let note = app.textFields["run-note"]
		note.tap()
		note.typeText("The selected category vanished")
		app.buttons["Done"].tap()
		app.buttons["record-fail"].tap()
		XCTAssertTrue(app.staticTexts["No slot left"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["run-notice"].label.contains("Fail recorded"))
		app.buttons["Undo"].tap()
		XCTAssertTrue(app.staticTexts["Catalog keeps the selected filters"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["run-notice"].label.contains("corrected to skipped"))
		app.buttons["record-blocked"].tap()
		XCTAssertTrue(app.staticTexts["No slot left"].waitForExistence(timeout: 10))
		app.navigationBars.buttons["Run"].tap()
		app.swipeUp()
		XCTAssertTrue(
			app.staticTexts["Person \(environment["MAINWORTHY_TEST_NAME"] ?? "") · pass"].waitForExistence(
				timeout: 5))
		XCTAssertTrue(app.staticTexts["Person \(environment["MAINWORTHY_TEST_NAME"] ?? "") · blocked"].exists)
		shot("4-recorded-slots")
		app.navigationBars.buttons["Runs"].tap()
		app.buttons["plan-run"].tap()
		let name = app.textFields["run-name"]
		XCTAssertTrue(name.waitForExistence(timeout: 5))
		name.tap()
		name.typeText("Phone regression")
		app.buttons["run-selection"].tap()
		app.buttons["Tag"].tap()
		let filter = app.textFields["run-filter"]
		filter.tap()
		filter.typeText("regression")
		app.buttons["Done"].tap()
		shot("5-plan")
		app.buttons["submit-run-plan"].tap()
		XCTAssertTrue(app.staticTexts["Phone regression"].waitForExistence(timeout: 10))
		app.navigationBars.buttons["Runs"].tap()
		XCTAssertTrue(app.staticTexts["Phone regression"].waitForExistence(timeout: 10))
		shot("6-planned-list")
	}
}
