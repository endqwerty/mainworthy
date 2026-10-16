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

/// Reports three more tests with no case, each in its own file, so the project asks about four.
private func reportUnlinkedTests(in project: String) async throws {
	let environment = ProcessInfo.processInfo.environment
	let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
	var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)/api/p/\(project)/report")))
	request.httpMethod = "POST"
	request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
	request.setValue("application/json", forHTTPHeaderField: "Content-Type")
	let results = ["search", "wishlist", "returns"].map { file in
		#"{"test":{"key":"tests/\#(file).spec.ts::\#(file)","name":"The \#(file) page opens","file":"tests/\#(file).spec.ts"},"outcome":"pass"}"#
	}
	let commit = String(repeating: "5", count: 40)
	request.httpBody = Data(
		#"{"target":{"commit":"\#(commit)","repo":"acme/shop","branch":"main"},"job":"more","results":[\#(results.joined(separator: ","))]}"#.utf8
	)
	let (_, response) = try await URLSession.shared.data(for: request)
	XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
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
		XCTAssertTrue(app.textFields["name"].waitForExistence(timeout: 20))
		// The screen asks for a name and a password: not which instance (issue #233), and no token.
		XCTAssertFalse(app.textFields["address"].exists)
		XCTAssertFalse(app.secureTextFields["token"].exists || app.buttons["Token"].exists)
		app.textFields["name"].tap()
		app.textFields["name"].typeText(environment["MAINWORTHY_TEST_NAME"] ?? "")
		app.secureTextFields["password"].tap()
		app.secureTextFields["password"].typeText(environment["MAINWORTHY_TEST_PASSWORD"] ?? "")
		shot("1-sign-in")
		app.buttons["sign-in"].tap()
		XCTAssertTrue(app.navigationBars["Queue"].waitForExistence(timeout: 20))
	}

	@MainActor private func selectProject(_ project: String, in app: XCUIApplication) {
		let projectMenu = app.buttons["project-menu"]
		projectMenu.tap()
		let projectOption = app.collectionViews.buttons[project]
		let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND hittable == true"), object: projectOption)
		XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed)
		projectOption.tap()
		let selected = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", project), object: projectMenu)
		XCTAssertEqual(XCTWaiter.wait(for: [selected], timeout: 10), .completed)
	}

	@MainActor private func dropConfirmation(in app: XCUIApplication) -> XCUIElement {
		let confirm = app.buttons.matching(
			NSPredicate(format: "label == %@ AND identifier != %@", "Drop saved answer", "drop-saved-answer")
		).firstMatch
		XCTAssertTrue(confirm.waitForExistence(timeout: 5))
		return confirm
	}

	@MainActor func testLinkAnUnlinkedTestAndCreateACase() async throws {
		let project = try await makeProject()
		let second = try await makeProject()
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)
		selectProject(project, in: app)
		let question = app.staticTexts["1 test in tests/shipping.spec.ts has no case"]
		XCTAssertTrue(question.waitForExistence(timeout: 10))
		question.tap()
		app.buttons["answer-link"].tap()
		let choose = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'map-case-' ")).firstMatch
		XCTAssertTrue(choose.waitForExistence(timeout: 5))
		choose.tap()
		let search = app.searchFields.firstMatch
		XCTAssertTrue(search.waitForExistence(timeout: 5))
		search.tap()
		search.typeText("password")
		let picked = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Password reset restores access'")).firstMatch
		XCTAssertTrue(picked.waitForExistence(timeout: 10))
		picked.tap()
		XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH ': Shipping accepts an address'")).firstMatch.waitForExistence(timeout: 5))
		shot("map-link-review")
		app.buttons["submit-mapping"].tap()
		let notice = app.staticTexts["mapping-notice"]
		XCTAssertTrue(notice.waitForExistence(timeout: 10))
		XCTAssertTrue(notice.label.hasPrefix("Recorded: the shown tests are linked"), notice.label)
		XCTAssertFalse(app.staticTexts["Question changed"].exists)
		XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Current answer:'")).firstMatch.exists)
		shot("map-linked")
		app.buttons["Done"].tap()
		app.navigationBars.buttons.element(boundBy: 0).tap()

		selectProject(second, in: app)
		XCTAssertTrue(question.waitForExistence(timeout: 10))
		question.tap()
		app.buttons["answer-create"].tap()
		XCTAssertTrue(app.staticTexts["New case: Shipping accepts an address"].waitForExistence(timeout: 5))
		shot("map-create-review")
		app.buttons["submit-mapping"].tap()
		XCTAssertTrue(notice.waitForExistence(timeout: 10))
		XCTAssertTrue(notice.label.hasPrefix("Recorded: one new case per shown test"), notice.label)
		XCTAssertFalse(app.staticTexts["Question changed"].exists)
		XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Current answer:'")).firstMatch.exists)
		shot("map-created")
	}

	@MainActor func testSelectSeveralUnlinkedTestsAndAnswerThemTogether() async throws {
		let project = try await makeProject()
		try await reportUnlinkedTests(in: project)
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)
		selectProject(project, in: app)
		XCTAssertTrue(app.staticTexts["1 test in tests/search.spec.ts has no case"].waitForExistence(timeout: 10))
		app.buttons["queue-select"].tap()
		let count = app.staticTexts["selection-count"]
		XCTAssertTrue(count.waitForExistence(timeout: 5))
		XCTAssertEqual(count.label, "Select questions of one kind to give them one answer.")
		let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'select-Q-'"))
		let unlinked = rows.matching(NSPredicate(format: "label CONTAINS 'has no case'"))
		XCTAssertEqual(unlinked.count, 4)
		unlinked.element(boundBy: 0).tap()
		XCTAssertEqual(count.label, "1 unlinked selected")
		// A failure is another kind: it says so and stays out.
		let failure = rows.matching(NSPredicate(format: "label CONTAINS 'expected $90.00'")).firstMatch
		failure.tap()
		XCTAssertTrue(app.staticTexts["notice"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.staticTexts["notice"].label.hasSuffix("one answer is for one kind."), app.staticTexts["notice"].label)
		XCTAssertEqual(count.label, "1 unlinked selected")
		app.buttons["select-all"].tap()
		XCTAssertEqual(count.label, "4 unlinked selected")
		shot("bulk-selected")
		app.buttons["bulk-answer"].tap()
		XCTAssertFalse(app.buttons["bulk-link"].exists)
		app.buttons["bulk-track"].tap()
		let confirm = app.buttons["bulk-confirm"].firstMatch
		XCTAssertTrue(confirm.waitForExistence(timeout: 5))
		shot("bulk-confirm")
		confirm.tap()
		let notice = app.staticTexts["notice"]
		let recorded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "4 unlinked: Track without a case."), object: notice)
		XCTAssertEqual(XCTWaiter.wait(for: [recorded], timeout: 15), .completed, notice.label)
		XCTAssertEqual(unlinked.count, 0)
		shot("bulk-recorded")
		app.buttons["undo-all"].tap()
		let withdrawn = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "4 decisions are withdrawn."), object: notice)
		XCTAssertEqual(XCTWaiter.wait(for: [withdrawn], timeout: 15), .completed, notice.label)
		let back = XCTNSPredicateExpectation(predicate: NSPredicate(format: "count == 4"), object: unlinked)
		XCTAssertEqual(XCTWaiter.wait(for: [back], timeout: 10), .completed)
		app.buttons["queue-select"].tap()
		XCTAssertFalse(count.exists)
		XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'question-Q-'")).firstMatch.exists)
	}

	@MainActor func testSavedAnswerSurvivesClosingAndShowsItsOutcome() async throws {
		let project = try await makeProject()
		func connection(unavailable: Bool, uncertain: Bool = false) async throws -> String {
			let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
			var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)/test/answer-connection")))
			request.httpMethod = "POST"
			request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
			request.httpBody = try JSONSerialization.data(withJSONObject: ["project": project, "unavailable": unavailable, "failure": uncertain ? "uncertain" : "rejected"])
			let (data, _) = try await URLSession.shared.data(for: request)
			struct Reply: Decodable { struct Result: Decodable { let url: String }; let result: Result }
			return try JSONDecoder().decode(Reply.self, from: data).result.url
		}
		let proxy = try await connection(unavailable: true)
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", proxy]
		app.launch()
		try signIn(app)
		selectProject(project, in: app)
		let failure = app.staticTexts["expected $90.00, got $100.00"]
		XCTAssertTrue(failure.waitForExistence(timeout: 10))
		failure.tap()
		app.buttons["answer-flaky"].tap()
		let pending = app.staticTexts["question-notice"]
		XCTAssertTrue(pending.waitForExistence(timeout: 15))
		XCTAssertTrue(pending.label.contains("waiting to send"), pending.label)
		app.navigationBars.buttons.element(boundBy: 0).tap()
		app.buttons["unsent-answers"].tap()
		XCTAssertTrue(app.staticTexts["Waiting to send"].waitForExistence(timeout: 10))
		shot("206-unsent-answers")

		app.terminate()
		app.launchArguments = ["-instance", proxy]
		app.launch()
		// The unsigned simulator build cannot use the keychain, so this run signs in again after relaunch.
		// Signed device builds keep their session. This test proves answer persistence, not keychain persistence.
		if app.textFields["name"].waitForExistence(timeout: 3) { try signIn(app) }
		XCTAssertTrue(app.navigationBars["Queue"].waitForExistence(timeout: 20))
		app.buttons["unsent-answers"].tap()
		XCTAssertTrue(app.staticTexts["Waiting to send"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["The answer could not be recorded. The saved answer is waiting to send."].exists)
		XCTAssertTrue(app.buttons["retry-saved-answer"].exists)
		XCTAssertTrue(app.buttons["drop-saved-answer"].exists)
		shot("321-stuck-answer")
		app.buttons["retry-saved-answer"].tap()
		let canDrop = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: app.buttons["drop-saved-answer"])
		XCTAssertEqual(XCTWaiter.wait(for: [canDrop], timeout: 10), .completed)
		XCTAssertTrue(app.staticTexts["Waiting to send"].exists)
		app.buttons["drop-saved-answer"].tap()
		_ = dropConfirmation(in: app)
		shot("321-drop-confirmation")
		if app.buttons["Cancel"].exists {
			app.buttons["Cancel"].tap()
		} else {
			let dismiss = app.otherElements["PopoverDismissRegion"]
			XCTAssertTrue(dismiss.exists)
			dismiss.tap()
		}
		XCTAssertTrue(app.staticTexts["Waiting to send"].exists)
		app.buttons["drop-saved-answer"].tap()
		dropConfirmation(in: app).tap()
		let removed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.staticTexts["Waiting to send"])
		XCTAssertEqual(XCTWaiter.wait(for: [removed], timeout: 10), .completed)
		shot("321-definite-error-removed")
		// An unreadable reply cannot prove that no request is still on its way.
		_ = try await connection(unavailable: true, uncertain: true)
		app.navigationBars.buttons.element(boundBy: 0).tap()
		XCTAssertTrue(failure.waitForExistence(timeout: 10))
		failure.tap()
		app.buttons["answer-flaky"].tap()
		XCTAssertTrue(pending.waitForExistence(timeout: 15))
		app.navigationBars.buttons.element(boundBy: 0).tap()
		app.buttons["unsent-answers"].tap()
		XCTAssertTrue(app.staticTexts["Waiting to send"].waitForExistence(timeout: 10))
		app.buttons["drop-saved-answer"].tap()
		dropConfirmation(in: app).tap()
		XCTAssertTrue(app.staticTexts["Dropped"].waitForExistence(timeout: 10))
		XCTAssertFalse(app.staticTexts["Waiting to send"].exists)
		shot("321-dropped-answer")
		app.terminate()
		app.launch()
		if app.textFields["name"].waitForExistence(timeout: 3) { try signIn(app) }
		XCTAssertTrue(app.navigationBars["Queue"].waitForExistence(timeout: 20))
		app.buttons["unsent-answers"].tap()
		XCTAssertTrue(app.staticTexts["Dropped"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.buttons["send-waiting-answers"].isEnabled)
		_ = try await connection(unavailable: false)
		app.navigationBars.buttons.element(boundBy: 0).tap()
		XCTAssertTrue(failure.waitForExistence(timeout: 10))
		failure.tap()
		app.buttons["answer-flaky"].tap()
		XCTAssertTrue(app.staticTexts["notice"].waitForExistence(timeout: 15))
		app.buttons["unsent-answers"].tap()
		XCTAssertTrue(app.staticTexts["Recorded"].waitForExistence(timeout: 15))
		XCTAssertTrue(app.staticTexts["Dropped"].exists)
		XCTAssertFalse(app.staticTexts["Waiting to send"].exists)
		shot("206-recorded-answer")
	}

	@MainActor func testAPersonSignsInAnswersAQuestionAndTakesItBack() async throws {
		let project = try await makeProject()
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)

		// The instance's first project is empty. The test's own is opened from the menu.
		selectProject(project, in: app)
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
		// The licence, and who holds the copyright, as the App Store listing says it.
		let licence = NSPredicate(format: "label CONTAINS 'Apache License 2.0' OR value CONTAINS 'Apache License 2.0'")
		XCTAssertTrue(app.descendants(matching: .any).matching(licence).firstMatch.exists)
		XCTAssertEqual(app.staticTexts["copyright"].label, "Copyright 2026 Daniel Yang")
		XCTAssertTrue(app.descendants(matching: .any)["licences"].exists)
		shot("8-about")
		app.buttons["sign-out"].tap()
		app.buttons["Sign out"].firstMatch.tap()
		XCTAssertTrue(app.textFields["name"].waitForExistence(timeout: 10))
		XCTAssertFalse(app.textFields["address"].exists)
	}
}
