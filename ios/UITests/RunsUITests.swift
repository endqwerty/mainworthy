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
		// Filled slots open for reading; only an eligible slot offers recording.
		XCTAssertTrue(app.buttons["run-slot-1"].exists)
		app.swipeUp()
		XCTAssertTrue(app.buttons["run-slot-5"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons["run-slot-4"].exists)
		XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "In progress · robin · since")).firstMatch.waitForExistence(timeout: 10))
		shot("2b-left-to-others")
		XCTAssertTrue(
			app.staticTexts[
				"Open any slot to read its results. A slot filled only by another producer is read-only."
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
		app.buttons["run-selection"].tap()
		app.buttons["Search"].tap()
		let filter = app.textFields["run-filter"]
		filter.tap()
		filter.typeText("Order total includes shipping")
		app.buttons["Done"].tap()
		XCTAssertTrue(app.staticTexts["1 matching case"].waitForExistence(timeout: 10))
		shot("5a-single-case")
		app.buttons["Cancel"].tap()
		XCTAssertTrue(app.buttons["plan-run"].waitForExistence(timeout: 5))
		app.buttons["plan-run"].tap()
		XCTAssertTrue(name.waitForExistence(timeout: 5))
		name.tap()
		name.typeText("Phone regression")
		app.buttons["run-selection"].tap()
		app.buttons["Tag"].tap()
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
		app.staticTexts["A late phone plan"].tap()
		XCTAssertTrue(app.buttons["start-run"].waitForExistence(timeout: 10))
		app.navigationBars.buttons["Runs"].tap()
		app.buttons["plan-run"].tap()
		XCTAssertTrue(app.buttons["Plan"].waitForExistence(timeout: 10))
		XCTAssertEqual(name.value as? String, "Run name")
		XCTAssertTrue(name.isEnabled)
		XCTAssertFalse(app.buttons["Read run again"].exists)
		XCTAssertFalse(app.staticTexts["plan-notice"].exists)
		name.tap()
		name.typeText("A fresh phone plan")
		app.buttons["Done"].tap()
		shot("planner-fresh-after-cancel")
		app.buttons["submit-run-plan"].tap()
		XCTAssertTrue(app.buttons["start-run"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["A fresh phone plan"].exists)
	}

	@MainActor func testReopenedPlannerOpensTheLatePlan() async throws {
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
		name.tap()
		name.typeText("Reopened late plan")
		app.buttons["Done"].tap()
		app.buttons["submit-run-plan"].tap()
		var committed = false
		for _ in 0..<100 {
			if try await planConnection(project, mode: "status").committed { committed = true; break }
			try await Task.sleep(for: .milliseconds(50))
		}
		XCTAssertTrue(committed, "The server must commit before Cancel and reopening the planner")
		app.buttons["Cancel"].tap()
		XCTAssertTrue(app.buttons["plan-run"].waitForExistence(timeout: 5))
		app.buttons["plan-run"].tap()
		XCTAssertTrue(app.buttons["Retry plan"].waitForExistence(timeout: 10))
		XCTAssertEqual(name.value as? String, "Reopened late plan")
		XCTAssertFalse(name.isEnabled)
		shot("planner-reopened-pending")
		_ = try await planConnection(project, mode: "normal")
		let opened = app.buttons["start-run"].waitForExistence(timeout: 10)
		shot("planner-reopened-late-reply")
		XCTAssertTrue(opened)
		XCTAssertTrue(app.staticTexts["Reopened late plan"].exists)
		XCTAssertFalse(name.exists)
		app.navigationBars.buttons["Runs"].tap()
		XCTAssertEqual(app.staticTexts.matching(identifier: "Reopened late plan").count, 1)
		app.buttons["plan-run"].tap()
		XCTAssertTrue(name.waitForExistence(timeout: 5))
		XCTAssertEqual(name.value as? String, "Run name")
		XCTAssertTrue(name.isEnabled)
		XCTAssertFalse(app.buttons["submit-run-plan"].isEnabled)
		XCTAssertFalse(app.staticTexts["plan-notice"].exists)
		shot("planner-fresh-after-reopened-success")
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

	@MainActor func testRetryKeepsTheSubmittedReport() async throws {
		let project = try await makeProject()
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		func connection(_ mode: String) async throws -> String {
			var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)/test/plan-connection")))
			request.httpMethod = "POST"
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
			request.httpBody = try JSONSerialization.data(withJSONObject: ["project": project, "mode": mode, "operation": "report"])
			let (data, response) = try await URLSession.shared.data(for: request)
			XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
			return try JSONDecoder().decode(PlanConnection.self, from: data).result.url
		}
		let proxy = try await connection("unreadable")
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", proxy]
		app.launch()
		try signIn(app)
		app.openProject(project)
		app.openTab("Runs")
		XCTAssertTrue(app.staticTexts["Checkout regression"].waitForExistence(timeout: 15))
		app.staticTexts["Checkout regression"].tap()
		XCTAssertTrue(app.buttons["start-run"].waitForExistence(timeout: 10))
		app.buttons["start-run"].tap()
		XCTAssertTrue(app.staticTexts["executing-case"].waitForExistence(timeout: 10))
		let note = app.textFields["run-note"]
		note.tap()
		note.typeText("Keep this reported observation")
		app.buttons["Done"].tap()
		app.buttons["record-fail"].tap()
		XCTAssertTrue(app.buttons["retry-report"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["run-notice"].label.contains("outcome is unknown"))
		XCTAssertFalse(app.buttons["record-pass"].exists)
		shot("report-uncertain")
		_ = try await connection("normal")
		app.buttons["retry-report"].tap()
		XCTAssertTrue(app.staticTexts["Catalog keeps the selected filters"].waitForExistence(timeout: 10))
		XCTAssertFalse(app.buttons["retry-report"].exists)
		XCTAssertTrue(app.staticTexts["run-notice"].label.contains("Fail recorded"))
		shot("report-recovered")
		app.buttons["Undo"].tap()
		XCTAssertTrue(app.staticTexts["Order total includes shipping"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["run-notice"].label.contains("corrected to skipped"))
	}

	@MainActor func testSetAsideARefusedReportResend() async throws {
		let project = try await makeProject()
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		let session = URLSession(configuration: .ephemeral)
		defer { session.invalidateAndCancel() }
		func request(_ path: String, _ body: [String: Any], owner: Bool = false) async throws -> Data {
			var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)\(path)")))
			request.httpMethod = "POST"
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			if owner { request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization") }
			request.httpBody = try JSONSerialization.data(withJSONObject: body)
			let (data, response) = try await session.data(for: request)
			XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
			return data
		}
		struct Connection: Decodable {
			struct Value: Decodable { var url: String; var arrived: Bool? }
			var result: Value
		}
		func connection(_ mode: String) async throws -> Connection.Value {
			let data = try await request("/test/plan-connection", ["project": project, "operation": "report", "mode": mode], owner: true)
			return try JSONDecoder().decode(Connection.self, from: data).result
		}
		struct Runs: Decodable {
			struct Page: Decodable {
				struct Row: Decodable { var ref: String; var name: String }
				var items: [Row]
			}
			var result: Page
		}
		struct Slots: Decodable {
			struct Page: Decodable {
				struct Row: Decodable { var `case`: String; var title: String }
				var items: [Row]
			}
			var result: Page
		}
		struct Report: Decodable {
			struct Value: Decodable { var results: [Int] }
			var result: Value
		}
		_ = try await request("/api/login", ["name": environment["MAINWORTHY_TEST_NAME"] ?? "", "password": environment["MAINWORTHY_TEST_PASSWORD"] ?? ""])
		let runs = try JSONDecoder().decode(Runs.self, from: await request("/api/p/\(project)/find", ["in": "runs"]))
		let run = try XCTUnwrap(runs.result.items.first { $0.name == "Checkout regression" })
		let slots = try JSONDecoder().decode(Slots.self, from: await request("/api/p/\(project)/find", ["in": "slots", "run": run.ref]))
		let index = try XCTUnwrap(slots.result.items.firstIndex { $0.title == "Order total includes shipping" })
		let ref = slots.result.items[index].case
		let first = try JSONDecoder().decode(Report.self, from: await request("/api/p/\(project)/report", [
			"run": run.ref, "results": [["test": ["case": ref], "outcome": "pass"]]
		]))
		let original = try XCTUnwrap(first.result.results.first)
		struct Timeline: Decodable {
			struct Value: Decodable {
				struct Entry: Decodable { var t: String }
				var entries: [Entry]
			}
			var result: Value
		}
		func resultCount() async throws -> Int {
			let data = try await request("/api/p/\(project)/timeline", ["ref": ref])
			return try JSONDecoder().decode(Timeline.self, from: data).result.entries.filter { $0.t == "result" }.count
		}
		let proxy = try await connection("normal").url
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", proxy]
		app.launch()
		try signIn(app)
		app.openProject(project)
		app.openTab("Runs")
		XCTAssertTrue(app.staticTexts["Checkout regression"].waitForExistence(timeout: 15))
		app.staticTexts["Checkout regression"].tap()
		XCTAssertTrue(app.buttons["start-run"].waitForExistence(timeout: 10))
		let slot = app.buttons["run-slot-\(index + 1)"]
		app.swipeUp()
		XCTAssertTrue(slot.waitForExistence(timeout: 10))
		slot.tap()
		XCTAssertTrue(app.textFields["run-note"].waitForExistence(timeout: 10))
		shot("report-aside-before")
		_ = try await connection("before-unreadable")
		app.buttons["record-fail"].tap()
		var arrived = false
		for _ in 0..<100 {
			if try await connection("status").arrived == true { arrived = true; break }
			try await Task.sleep(for: .milliseconds(100))
		}
		XCTAssertTrue(arrived)
		_ = try await request("/api/p/\(project)/report", ["run": run.ref, "results": [
			["test": ["case": ref], "outcome": "blocked", "corrects": original]
		]])
		_ = try await connection("normal")
		XCTAssertTrue(app.buttons["retry-report"].waitForExistence(timeout: 10))
		XCTAssertFalse(app.buttons["set-report-aside"].exists)
		app.buttons["retry-report"].tap()
		XCTAssertTrue(app.buttons["set-report-aside"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["run-notice"].label.contains("The server refused this report's resend"))
		XCTAssertTrue(app.staticTexts["run-notice"].label.contains("already corrected"))
		XCTAssertFalse(app.buttons["record-pass"].exists)
		shot("report-aside-refused")
		app.buttons["set-report-aside"].tap()
		let warning = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "may still have been recorded, or may arrive later")).firstMatch
		XCTAssertTrue(warning.waitForExistence(timeout: 5))
		shot("report-aside-confirmation")
		app.navigationBars["Execute"].tap()
		XCTAssertTrue(app.buttons["set-report-aside"].exists)
		XCTAssertFalse(app.buttons["record-pass"].exists)
		app.buttons["set-report-aside"].tap()
		app.buttons["confirm-set-report-aside"].firstMatch.tap()
		XCTAssertTrue(app.textFields["run-note"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.buttons["record-pass"].isEnabled)
		XCTAssertTrue(app.buttons["run-step-1"].isEnabled)
		XCTAssertTrue(app.staticTexts["run-notice"].label.contains("set aside on this device"))
		shot("report-aside-after")
		let countBefore = try await resultCount()
		XCTAssertEqual(countBefore, 2)
		app.buttons["record-fail"].tap()
		XCTAssertTrue(app.staticTexts["Catalog keeps the selected filters"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["run-notice"].label.contains("Fail recorded"))
		let countAfter = try await resultCount()
		XCTAssertEqual(countAfter, 3)
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
		// A change run is named by its change's key and title, which the server's location gives.
		let changeRun = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "pr:482 ")).firstMatch
		XCTAssertTrue(changeRun.waitForExistence(timeout: 10))
		shot("7-every-kind")
		app.segmentedControls.buttons["Change"].tap()
		XCTAssertTrue(changeRun.waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["Checkout regression"].waitForNonExistence(timeout: 5))
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
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", address]
		app.launch()
		try signIn(app)
		app.openProject(project)
		app.openTab("Runs")
		XCTAssertTrue(app.staticTexts["Checkout regression"].waitForExistence(timeout: 15))
		_ = try await request("work", #"{"do":"take","run":"R-3","slot":\#(slots[0].id),"seconds":30}"#)
		_ = try await request("work", #"{"do":"take","run":"R-3","slot":\#(slots[1].id),"seconds":3600}"#)
		XCTAssertTrue(app.staticTexts["2 cases left · 2 in progress"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["2 cases left · 1 in progress"].waitForExistence(timeout: 45))
	}
}
