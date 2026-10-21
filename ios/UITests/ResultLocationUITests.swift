import XCTest

final class ResultLocationUITests: XCTestCase {
	private let environment = ProcessInfo.processInfo.environment
	override func setUp() { continueAfterFailure = false }

	@MainActor func testLandedFailureNamesItsPullRequest() async throws {
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		func post(_ path: String, _ body: [String: Any]) async throws -> [String: Any] {
			var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)\(path)")))
			request.httpMethod = "POST"
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
			request.httpBody = try JSONSerialization.data(withJSONObject: body)
			let (data, response) = try await URLSession.shared.data(for: request)
			XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
			let reply = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
			return try XCTUnwrap(reply["result"] as? [String: Any])
		}
		func shot(_ name: String) throws {
			let directory = try XCTUnwrap(environment["MAINWORTHY_SCREENSHOTS"])
			try XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent("identifier-\(name).png"))
		}
		let made = try await post("/test/project", ["kind": "demo"])
		let project = try XCTUnwrap(made["project"] as? String)
		let commit = "1234567890abcdef1234567890abcdef12345678"
		let results: [[String: Any]] = [["test": ["key": "landed-coupon", "name": "Landed coupon"], "outcome": "fail", "durationMs": 1400, "failure": ["message": "Coupon lost after merge"]]]
		_ = try await post("/api/p/\(project)/report", ["target": ["repo": "acme/shop", "commit": "feature0001", "branch": "coupon", "pr": 653, "title": "Keep coupons"], "results": results])
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
		let failure = app.staticTexts["Coupon lost after merge"].firstMatch
		XCTAssertTrue(failure.waitForExistence(timeout: 15))
		failure.tap()
		XCTAssertTrue(app.staticTexts["Where"].waitForExistence(timeout: 10))
		try shot("pr-failure")
		app.navigationBars.buttons["Queue"].tap()
		_ = try await post("/api/p/\(project)/change", ["change": "pr:653", "state": "merged", "landing": ["commit": commit, "branch": "main"]])
		let trunk = try await post("/api/p/\(project)/report", ["target": ["repo": "acme/shop", "commit": commit, "branch": "main"], "results": results])
		let gate = try XCTUnwrap(trunk["gate"] as? [String: Any])
		let run = try XCTUnwrap(gate["run"] as? String)
		XCTAssertTrue(failure.waitForExistence(timeout: 15))
		failure.tap()
		XCTAssertTrue(app.staticTexts["Where"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "1234567890ab")).firstMatch.waitForExistence(timeout: 10))
		try shot("trunk-failure")
		app.navigationBars.buttons["Queue"].tap()
		app.openTab("Cases")
		app.buttons["Automated tests"].tap()
		let search = app.searchFields.firstMatch
		XCTAssertTrue(search.waitForExistence(timeout: 10))
		search.tap()
		search.typeText("Landed coupon\n")
		let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'test-T-'" )).firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 10))
		row.tap()
		XCTAssertTrue(app.staticTexts["Latest results"].waitForExistence(timeout: 10))
		try shot("test-history")
		app.openTab("Changes")
		app.buttons["change-pr:653"].tap()
		XCTAssertTrue(app.staticTexts["change-verdict"].waitForExistence(timeout: 10))
		try shot("change")
		let changeRun = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'change-run-R-'" )).firstMatch
		for _ in 0..<6 where !changeRun.isHittable { app.swipeUp() }
		XCTAssertTrue(changeRun.waitForExistence(timeout: 10))
		try shot("change-runs")
		app.openTab("Runs")
		let runRow = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", run)).firstMatch
		XCTAssertTrue(runRow.waitForExistence(timeout: 10))
		runRow.tap()
		XCTAssertTrue(app.staticTexts["change-run-verdict"].waitForExistence(timeout: 10))
		// The run's facts are one label and value a row; its one result reported 1.4 s, and its job named none.
		XCTAssertTrue(app.staticTexts["Test time, 1.4 s"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["Commit, 1234567890ab"].exists)
		XCTAssertTrue(app.staticTexts["1.4 s · robin"].exists)
		try shot("trunk-run")
		app.openTab("Cases")
		let link = app.buttons["main · pr:653 Keep coupons"].firstMatch
		XCTAssertTrue(link.waitForExistence(timeout: 10))
		link.tap()
		XCTAssertTrue(app.staticTexts["change-verdict"].waitForExistence(timeout: 10))
	}
}
