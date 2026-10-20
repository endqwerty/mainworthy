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
		app.openProject(project)
		app.openTab("Runs")
		let regression = app.staticTexts["Checkout regression"]
		XCTAssertTrue(regression.waitForExistence(timeout: 15))
		shot("1-list")
		regression.tap()
		let start = app.buttons["start-run"]
		XCTAssertTrue(start.waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["1 in progress"].waitForExistence(timeout: 10))
		shot("2-run")
		// The pipeline filled the first four slots: each is left to that result, so its row does not open, and the
		// list says why. The fifth, which nobody filled, opens.
		XCTAssertFalse(app.buttons["run-slot-1"].exists)
		app.swipeUp()
		XCTAssertTrue(app.buttons["run-slot-5"].waitForExistence(timeout: 5))
		XCTAssertFalse(app.buttons["run-slot-4"].exists)
		XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "In progress · robin · since")).firstMatch.waitForExistence(timeout: 10))
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
		XCTAssertTrue(app.staticTexts["6 matching cases"].waitForExistence(timeout: 10))
		name.tap()
		name.typeText("Phone regression")
		app.buttons["run-selection"].tap()
		app.buttons["Tag"].tap()
		let filter = app.textFields["run-filter"]
		filter.tap()
		filter.typeText("regression")
		app.buttons["Done"].tap()
		XCTAssertTrue(app.staticTexts["3 matching cases"].waitForExistence(timeout: 10))
		shot("5-plan")
		app.buttons["submit-run-plan"].tap()
		XCTAssertTrue(app.staticTexts["Phone regression"].waitForExistence(timeout: 10))
		app.navigationBars.buttons["Runs"].tap()
		XCTAssertTrue(app.staticTexts["Phone regression"].waitForExistence(timeout: 10))
		shot("6-planned-list")
	}

	private struct PlanConnection: Decodable {
		struct Result: Decodable { let url: String; let committed: Bool }
		let result: Result
	}

	@MainActor private func planConnection(_ project: String, mode: String) async throws -> PlanConnection.Result {
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)/test/plan-connection")))
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
		request.httpBody = try JSONSerialization.data(withJSONObject: ["project": project, "mode": mode])
		let (data, response) = try await URLSession.shared.data(for: request)
		XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
		return try JSONDecoder().decode(PlanConnection.self, from: data).result
	}

	@MainActor func testCancelDoesNotOpenALatePlan() async throws {
		let project = try await makeProject()
		let proxy = try await planConnection(project, mode: "hold")
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", proxy.url]
		app.launch()
		try signIn(app)
		app.openProject(project)
		app.openTab("Runs")
		XCTAssertTrue(app.buttons["plan-run"].waitForExistence(timeout: 10))
		app.buttons["plan-run"].tap()
		let name = app.textFields["run-name"]
		XCTAssertTrue(name.waitForExistence(timeout: 5))
		XCTAssertTrue(app.staticTexts["6 matching cases"].waitForExistence(timeout: 10))
		name.tap()
		name.typeText("A late phone plan")
		app.buttons["Done"].tap()
		app.buttons["submit-run-plan"].tap()
		var committed = false
		for _ in 0..<100 {
			if try await planConnection(project, mode: "status").committed { committed = true; break }
			try await Task.sleep(for: .milliseconds(50))
		}
		XCTAssertTrue(committed, "The server must commit before Cancel and before releasing its reply")
		XCTAssertFalse(name.isEnabled)
		shot("planner-sending")
		app.buttons["Cancel"].tap()
		XCTAssertTrue(app.buttons["plan-run"].waitForExistence(timeout: 5))
		_ = try await planConnection(project, mode: "normal")
		XCTAssertTrue(app.staticTexts["A late phone plan"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.navigationBars["Runs"].exists)
		XCTAssertFalse(app.buttons["start-run"].exists)
		shot("planner-cancelled-late")
		app.buttons["plan-run"].tap()
		XCTAssertTrue(app.buttons["Read run again"].waitForExistence(timeout: 10))
		XCTAssertEqual(name.value as? String, "A late phone plan")
		XCTAssertFalse(name.isEnabled)
		shot("planner-recovered")
		app.buttons["submit-run-plan"].tap()
		XCTAssertTrue(app.buttons["start-run"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["A late phone plan"].exists)
	}

	@MainActor func testRetryKeepsTheSubmittedPlan() async throws {
		let project = try await makeProject()
		let proxy = try await planConnection(project, mode: "unreadable")
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", proxy.url]
		app.launch()
		try signIn(app)
		app.openProject(project)
		app.openTab("Runs")
		XCTAssertTrue(app.buttons["plan-run"].waitForExistence(timeout: 10))
		app.buttons["plan-run"].tap()
		let name = app.textFields["run-name"]
		XCTAssertTrue(name.waitForExistence(timeout: 5))
		name.tap()
		name.typeText("Keep the phone plan")
		app.buttons["Done"].tap()
		app.buttons["submit-run-plan"].tap()
		XCTAssertTrue(app.buttons["Retry plan"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["plan-notice"].label.contains("outcome is unknown"))
		XCTAssertFalse(name.isEnabled)
		XCTAssertFalse(app.buttons["run-selection"].isEnabled)
		shot("planner-uncertain")
		app.buttons["Cancel"].tap()
		app.buttons["plan-run"].tap()
		XCTAssertTrue(app.buttons["Retry plan"].waitForExistence(timeout: 10))
		XCTAssertEqual(name.value as? String, "Keep the phone plan")
		_ = try await planConnection(project, mode: "normal")
		app.buttons["submit-run-plan"].tap()
		XCTAssertTrue(app.buttons["start-run"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["Keep the phone plan"].exists)
		app.navigationBars.buttons["Runs"].tap()
		XCTAssertEqual(app.staticTexts.matching(identifier: "Keep the phone plan").count, 1)
		shot("planner-retry-opened")
	}

	@MainActor func testChangeRunsAndTheirResults() async throws {
		let project = try await makeProject()
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)
		app.openProject(project)
		app.openTab("Runs")
		XCTAssertTrue(app.staticTexts["Checkout regression"].waitForExistence(timeout: 15))
		// The filters stay under the bar: pulling to refresh moves the runs, not them.
		XCTAssertTrue(app.segmentedControls["runs-kind"].exists && app.segmentedControls["runs-state"].exists)
		XCTAssertFalse(app.collectionViews.firstMatch.segmentedControls["runs-kind"].exists)
		XCTAssertFalse(app.collectionViews.firstMatch.segmentedControls["runs-state"].exists)
		let changeRun = app.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", " on pr:482")).firstMatch
		XCTAssertTrue(changeRun.waitForExistence(timeout: 10))
		shot("7-every-kind")
		app.segmentedControls.buttons["Change"].tap()
		XCTAssertTrue(changeRun.waitForExistence(timeout: 10))
		XCTAssertFalse(app.staticTexts["Checkout regression"].waitForExistence(timeout: 2))
		shot("8-change-runs")
		changeRun.tap()
		XCTAssertTrue(app.staticTexts["Results"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["Apply a percentage coupon"].exists)
		shot("9-change-run")
		app.navigationBars.buttons["Runs"].tap()
		app.segmentedControls.buttons["Closed"].tap()
		XCTAssertTrue(app.staticTexts["No run matches."].waitForExistence(timeout: 10))
	}
	@MainActor func testRunListRefreshesWhenOnlyOneOfTwoLeasesExpires() async throws {
		let project = try await makeProject()
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		func request(_ op: String, _ body: String) async throws -> Data {
			var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)/api/p/\(project)/\(op)")))
			request.httpMethod = "POST"
			request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.httpBody = Data(body.utf8)
			let (data, response) = try await URLSession.shared.data(for: request)
			XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
			return data
		}
		struct Slots: Decodable {
			struct Page: Decodable { struct Slot: Decodable {let id: Int; let state: String}; let items: [Slot] }
			let result: Page
		}
		let data = try await request("find", #"{"in":"slots","run":"R-3"}"#)
		let slots = try JSONDecoder().decode(Slots.self, from: data).result.items.filter { $0.state == "missing" }
		XCTAssertEqual(slots.count, 2)
		_ = try await request("work", #"{"do":"take","run":"R-3","slot":\#(slots[0].id),"seconds":30}"#)
		_ = try await request("work", #"{"do":"take","run":"R-3","slot":\#(slots[1].id),"seconds":3600}"#)
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", address]
		app.launch()
		try signIn(app)
		app.openProject(project)
		app.openTab("Runs")
		XCTAssertTrue(app.staticTexts["2 cases left · 2 in progress"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["2 cases left · 1 in progress"].waitForExistence(timeout: 45))
	}
}
