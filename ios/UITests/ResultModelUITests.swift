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

	@MainActor func testAgentOnlySlotOpensReadOnly() async throws {
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		func post(_ path: String, _ body: [String: Any], token: String? = nil) async throws -> [String: Any] {
			var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)\(path)")))
			request.httpMethod = "POST"
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.setValue("Bearer \(token ?? environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
			request.httpBody = try JSONSerialization.data(withJSONObject: body)
			let (data, response) = try await URLSession.shared.data(for: request)
			XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
			let reply = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
			return try XCTUnwrap(reply["result"] as? [String: Any])
		}
		let made = try await post("/test/project", ["kind": "demo"])
		let project = try XCTUnwrap(made["project"] as? String)
		let plan = try await post("/api/p/\(project)/plan", ["name": "Agent-only evidence", "select": ["cases": ["C-2"]],
			"require": [["id": "exercise", "kind": "exercise", "methods": ["human", "agent"], "minActors": 1, "basis": "exact"]]])
		let run = try XCTUnwrap(plan["run"] as? String)
		let token = try await post("/api/admin", ["do": "token.create", "actor": "slot-reviewer",
			"kind": "agent", "label": "Agent-only trail", "can": ["read", "produce"], "project": project])
		let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
		let reported = try await post("/api/p/\(project)/report", ["run": run, "model": "test-agent", "results": [[
			"test": ["case": "C-2"], "outcome": "pass", "steps": [
				["step": "a1", "outcome": "pass", "durationMs": 100, "actions": [["text": "Open the cart"]]],
				["step": "c3", "outcome": "pass", "durationMs": 700, "attachment": 0]],
			"attachments": [["name": "agent-only.png", "data": png]]]]], token: try XCTUnwrap(token["token"] as? String))
		XCTAssertEqual((reported["results"] as? [Int])?.count, 1)
		XCTAssertEqual((reported["rejected"] as? [Any])?.count, 0)
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
		XCTAssertTrue(app.staticTexts["Agent-only evidence"].waitForExistence(timeout: 15))
		app.staticTexts["Agent-only evidence"].tap()
		XCTAssertTrue(app.staticTexts["Cases in order"].waitForExistence(timeout: 10))
		try shot("agent-only-row")
		let slot = app.buttons["run-slot-1"]
		XCTAssertTrue(slot.waitForExistence(timeout: 5))
		slot.tap()
		XCTAssertTrue(app.staticTexts["executing-case"].waitForExistence(timeout: 10))
		XCTAssertFalse(app.buttons["record-pass"].exists)
		for _ in 0..<5 where !app.staticTexts["Open the cart"].isHittable { app.swipeUp() }
		XCTAssertTrue(app.staticTexts["Open the cart"].exists)
		XCTAssertTrue(app.staticTexts["100 ms"].firstMatch.exists)
		try shot("agent-only-trail")
		let screenshot = app.buttons["Screenshot for step c3"].firstMatch
		for _ in 0..<5 where !screenshot.isHittable { app.swipeUp() }
		XCTAssertTrue(app.staticTexts["700 ms"].firstMatch.exists)
		screenshot.tap()
		XCTAssertTrue(app.staticTexts["screenshot-filename"].waitForExistence(timeout: 10))
		XCTAssertEqual(app.staticTexts["screenshot-filename"].label, "agent-only.png")
		XCTAssertTrue(app.images["screenshot-image"].exists)
		try shot("agent-only-screenshot")
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
