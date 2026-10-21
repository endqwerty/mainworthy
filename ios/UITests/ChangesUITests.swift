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
		XCTAssertTrue(app.textFields["name"].waitForExistence(timeout: 20))
		app.textFields["name"].tap()
		app.textFields["name"].typeText(environment["MAINWORTHY_TEST_NAME"] ?? "")
		app.secureTextFields["password"].tap()
		app.secureTextFields["password"].typeText(environment["MAINWORTHY_TEST_PASSWORD"] ?? "")
		app.buttons["sign-in"].tap()
		XCTAssertTrue(app.navigationBars["Queue"].waitForExistence(timeout: 20))
	}

	/// A pull request merged by rebase: its head passed, and `main` holds a rewritten commit no report has named yet,
	/// then one that fails. The head's gate stays the change's; the landed commit's gate is shown apart.
	@MainActor func testARebasedLandingKeepsTheHeadsGateAndShowsItsOwn() async throws {
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		func post(_ path: String, _ body: [String: Any]) async throws {
			var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)\(path)")))
			request.httpMethod = "POST"
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
			request.httpBody = try JSONSerialization.data(withJSONObject: body)
			let (_, response) = try await URLSession.shared.data(for: request)
			XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
		}
		let project = try await makeProject()
		let head = "18af80ce87f2026906aac60a5983edf403ffdec2"
		let landed = "3cc3a1e8af977afe91c871a7b0ded80519669240"
		let test: [String: Any] = ["key": "picker-scroll", "name": "Picker scrolls to the choice"]
		_ = try await post("/api/p/\(project)/report", [
			"target": ["repo": "acme/shop", "commit": head, "branch": "picker", "pr": 677, "title": "Fix picker scrolling"],
			"results": [["test": test, "outcome": "pass"]],
		])
		_ = try await post("/api/p/\(project)/change", [
			"change": "pr:677", "state": "merged", "head": head, "landing": ["commit": landed, "branch": "main"],
		])
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", address]
		app.launch()
		try signIn(app)
		app.openProject(project)
		app.openTab("Changes")
		let row = app.buttons["change-pr:677"]
		XCTAssertTrue(row.waitForExistence(timeout: 10))
		row.tap()
		let verdict = app.staticTexts["change-verdict"]
		XCTAssertTrue(verdict.waitForExistence(timeout: 10))
		shot("change-rebased-unreported")
		XCTAssertEqual(verdict.label, "passed")
		XCTAssertEqual(
			app.staticTexts["change-ending"].label,
			"Merged. It landed on main as another commit, which has a gate of its own."
		)
		XCTAssertEqual(app.staticTexts["change-landing-verdict"].label, "pending")
		XCTAssertEqual(
			app.staticTexts["change-landing-reason"].label,
			"pending: nothing a gate counts has been reported for this commit"
		)
		_ = try await post("/api/p/\(project)/report", [
			"target": ["repo": "acme/shop", "commit": landed, "branch": "main"],
			"results": [["test": test, "outcome": "fail", "failure": ["message": "Picker lost its place on main"]]],
		])
		app.swipeDown()
		let blocked = NSPredicate(format: "label == %@", "blocked")
		let landedBlocked = expectation(for: blocked, evaluatedWith: app.staticTexts["change-landing-verdict"])
		let shown = await XCTWaiter.fulfillment(of: [landedBlocked], timeout: 10)
		shot("change-rebased-blocked-on-main")
		XCTAssertEqual(shown, .completed)
		XCTAssertEqual(verdict.label, "passed")
	}

	/// A pull request whose job reports in six shards, three of them in: the gate counts the shards it waits for and
	/// draws them, and a tap on the strip spells them out, on the change and on its run.
	@MainActor func testAGateWaitingForShardsDrawsThem() async throws {
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		let project = try await makeProject()
		for index in 1...3 {
			var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)/api/p/\(project)/report")))
			request.httpMethod = "POST"
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
			request.httpBody = try JSONSerialization.data(withJSONObject: [
				"target": [
					"repo": "acme/shop", "commit": "5ba4d0000000000000000000000000000000000a", "branch": "estimate",
					"pr": 684, "title": "Show the shipping estimate",
				],
				"job": "tests", "shard": ["index": index, "of": 6],
				"results": [["test": ["key": "estimate-\(index)", "name": "Estimate \(index)"], "outcome": "pass"]],
			] as [String: Any])
			let (_, response) = try await URLSession.shared.data(for: request)
			XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
		}
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", address]
		app.launch()
		try signIn(app)
		app.openProject(project)
		app.openTab("Changes")
		let row = app.buttons["change-pr:684"]
		XCTAssertTrue(row.waitForExistence(timeout: 10))
		row.tap()
		let reason = app.staticTexts["change-reason"]
		XCTAssertTrue(reason.waitForExistence(timeout: 10))
		XCTAssertEqual(reason.label, "pending: waiting for 3 shards")
		let said = "Job tests: 3 of 6 shards reported (1, 2 and 3). Waiting for shards 4, 5 and 6."
		let strip = app.descendants(matching: .any).matching(identifier: "shard-strip").firstMatch
		shot("change-waiting-for-shards")
		XCTAssertTrue(strip.waitForExistence(timeout: 5))
		XCTAssertEqual(strip.label, said)
		strip.tap()
		XCTAssertTrue(app.staticTexts[said].waitForExistence(timeout: 5))
		shot("change-waiting-for-shards-explained")
	}

	@MainActor func testAChangeUnblocksAndThisDevicesSessionIsMarked() async throws {
		// The chosen project is beyond the first page of the picker.
		var project = try await makeProject()
		for _ in 1..<30 { project = try await makeProject() }
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)
		app.openProject(project)
		XCTAssertTrue(app.buttons["project-menu"].label.contains(project))
		XCTAssertTrue(app.staticTexts["expected $90.00, got $100.00"].waitForExistence(timeout: 10))
		app.openTab("Changes")
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
		// The change's runs, one per reported commit; one opens to what its gate counted.
		let runRow = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "change-run-R-")).firstMatch
		for _ in 0..<4 where !runRow.isHittable { app.swipeUp() }
		XCTAssertTrue(runRow.waitForExistence(timeout: 10))
		shot("change-runs")
		let ref = String(runRow.identifier.dropFirst("change-run-".count))
		runRow.tap()
		XCTAssertTrue(app.navigationBars[ref].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["Results"].waitForExistence(timeout: 10))
		shot("change-run")
		app.navigationBars.buttons["pr:482"].tap()
		app.tabBars.buttons["You"].tap()
		app.buttons["Your sessions"].tap()
		XCTAssertTrue(app.staticTexts["current-session"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Mainworthy for iPhone")).firstMatch.exists)
		shot("sessions-list")
	}
}
