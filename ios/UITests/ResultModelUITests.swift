import XCTest

final class ResultModelUITests: XCTestCase {
	private let environment = ProcessInfo.processInfo.environment
	private var shotPrefix: String { environment["MAINWORTHY_TEST_APPEARANCE"] == "dark" ? "dark-" : "" }
	override func setUp() { continueAfterFailure = false }

	@MainActor private func shot(_ name: String) throws {
		let directory = try XCTUnwrap(environment["MAINWORTHY_SCREENSHOTS"])
		try XCUIScreen.main.screenshot().pngRepresentation.write(
			to: URL(fileURLWithPath: directory).appendingPathComponent("model-\(shotPrefix)\(name).png"))
	}

	@MainActor func testModelBesideResultProducers() async throws {
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)/test/project")))
		request.httpMethod = "POST"
		request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
		request.httpBody = Data("{\"kind\":\"demo\"}".utf8)
		let (data, _) = try await URLSession.shared.data(for: request)
		struct Reply: Decodable {
			struct Made: Decodable { let project: String }
			let result: Made
		}
		let project = try JSONDecoder().decode(Reply.self, from: data).result.project
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
		app.openProject(project)
		app.openTab("Runs")
		let run = app.staticTexts["Agent checkout check"]
		XCTAssertTrue(run.waitForExistence(timeout: 15))
		run.tap()
		let slot = app.buttons["run-slot-1"]
		XCTAssertTrue(slot.waitForExistence(timeout: 10))
		XCTAssertTrue(slot.label.contains("reviewer · claude-opus-5-5"))
		try shot("run")
		slot.tap()
		XCTAssertTrue(app.staticTexts["executing-case"].waitForExistence(timeout: 10))
		app.swipeUp()
		XCTAssertTrue(app.staticTexts.matching(identifier: "Agent reviewer · claude-opus-5-5 · pass").firstMatch.waitForExistence(timeout: 10))
		let agentTrail = app.staticTexts["Step a1"].firstMatch
		XCTAssertTrue(agentTrail.waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["100 ms"].firstMatch.exists)
		try shot("slot")
		for _ in 0..<5 where !app.buttons["Screenshot for step c3"].firstMatch.isHittable { app.swipeUp() }
		let agentScreenshot = app.buttons["Screenshot for step c3"].firstMatch
		XCTAssertTrue(agentScreenshot.isHittable)
		agentScreenshot.tap()
		XCTAssertTrue(app.staticTexts["screenshot-filename"].waitForExistence(timeout: 10))
		XCTAssertEqual(app.staticTexts["screenshot-filename"].label, "cart.png")
		XCTAssertTrue(app.images["screenshot-image"].exists)
		try shot("agent-screenshot")
		app.buttons["Done"].tap()
		app.navigationBars.buttons["Run"].tap()
		app.navigationBars.buttons["Runs"].tap()
		app.openTab("Cases")
		app.buttons["Automated tests"].tap()
		let search = app.searchFields.firstMatch
		XCTAssertTrue(search.waitForExistence(timeout: 10))
		search.tap()
		search.typeText("coupon")
		let test = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "test-T-")).firstMatch
		XCTAssertTrue(test.waitForExistence(timeout: 10))
		test.tap()
		let producer = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "claude-opus-5-5")).firstMatch
		XCTAssertTrue(producer.waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["Step a1"].firstMatch.waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["100 ms"].firstMatch.exists)
		try shot("test")
		app.openTab("Changes")
		app.buttons["change-pr:482"].tap()
		XCTAssertTrue(app.staticTexts["change-verdict"].waitForExistence(timeout: 10))
		app.swipeUp()
		try shot("change")
		let filter = app.textFields["results-filter"]
		for _ in 0..<5 where !filter.isHittable { app.swipeDown() }
		XCTAssertTrue(filter.waitForExistence(timeout: 10))
		filter.tap()
		filter.typeText("coupon\n")
		app.swipeUp()
		let pipelineShot = app.buttons["Screenshot for step c3"].firstMatch
		for _ in 0..<6 where !pipelineShot.isHittable { app.swipeUp() }
		XCTAssertTrue(pipelineShot.waitForExistence(timeout: 10))
		XCTAssertTrue(pipelineShot.isHittable)
		XCTAssertTrue(app.staticTexts["700 ms"].firstMatch.exists)
		try shot("change-trail")
		pipelineShot.tap()
		XCTAssertTrue(app.staticTexts["screenshot-filename"].waitForExistence(timeout: 10))
		XCTAssertEqual(app.staticTexts["screenshot-filename"].label, "cart.png")
		XCTAssertTrue(app.images["screenshot-image"].exists)
		try shot("pipeline-screenshot")
		app.buttons["Done"].tap()
	}
}
