import XCTest
import UIKit

final class SuiteUITests: XCTestCase {
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
			struct Made: Decodable { var project: String }
			var result: Made
		}
		return try JSONDecoder().decode(Reply.self, from: data).result.project
	}

	@MainActor private func shot(_ name: String) {
		let screenshot = XCUIScreen.main.screenshot()
		let attachment = XCTAttachment(screenshot: screenshot)
		attachment.name = "suite-\(name)"
		attachment.lifetime = .keepAlways
		add(attachment)
		guard let directory = environment["MAINWORTHY_SCREENSHOTS"] else { return }
		try? screenshot.pngRepresentation.write(
			to: URL(fileURLWithPath: directory).appendingPathComponent("suite-\(name).png"))
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

	@MainActor private func addStep(_ app: XCUIApplication, action: String, expected: String) {
		let actions = app.textFields.matching(NSPredicate(format: "identifier BEGINSWITH 'editor-action-'"))
		let before = actions.allElementsBoundByIndex.map(\.identifier)
		app.buttons["editor-add-step"].tap()
		let added = actions.matching(NSPredicate(format: "NOT (identifier IN %@)", before as NSArray))
		for _ in 0..<6 where !added.firstMatch.exists { app.collectionViews.firstMatch.swipeUp() }
		XCTAssertEqual(added.count, 1)
		let identifier = added.firstMatch.identifier
		let field = app.textFields[identifier]
		field.tap()
		field.typeText(action)
		let step = String(identifier.dropFirst("editor-action-".count))
		let result = app.textFields["editor-expected-\(step)"]
		result.tap()
		result.typeText(expected)
	}

	/// The system's back gesture: a drag that starts at the left edge of the screen.
	@MainActor private func swipeBack(_ app: XCUIApplication) {
		let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.0, dy: 0.5))
		edge.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)))
	}

	@MainActor func testBrowseCreateEditAndHistory() async throws {
		XCUIDevice.shared.orientation = .portrait
		let project = try await makeProject()
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)
		app.openProject(project)
		app.openTab("Cases")
		XCTAssertTrue(app.buttons["folder-Checkout"].waitForExistence(timeout: 10))
		shot("folders")
		app.buttons["folder-Checkout"].tap()
		XCTAssertTrue(app.navigationBars["Checkout"].waitForExistence(timeout: 5))
		app.buttons["folder-Checkout/Coupons"].tap()
		let expired = app.staticTexts["Expired coupon is rejected"]
		XCTAssertTrue(expired.waitForExistence(timeout: 10))
		shot("folder")
		expired.tap()
		XCTAssertTrue(app.staticTexts["2. Apply the coupon OLD10"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["Error \"Coupon expired\"; total unchanged"].exists)
		shot("case")
		// Back, as in Files: a swipe from the left edge, twice, to the folder above.
		swipeBack(app)
		XCTAssertTrue(app.navigationBars["Coupons"].waitForExistence(timeout: 5))
		swipeBack(app)
		XCTAssertTrue(app.navigationBars["Checkout"].waitForExistence(timeout: 5))
		// A folder opened again shows its cases from what was read, with no spinner.
		app.buttons["folder-Checkout/Coupons"].tap()
		XCTAssertTrue(expired.waitForExistence(timeout: 2))
		XCTAssertFalse(app.activityIndicators.firstMatch.exists)
		// The magnifier searches the folder it was opened in, or everywhere.
		app.buttons["suite-search"].tap()
		let search = app.searchFields.firstMatch
		XCTAssertTrue(search.waitForExistence(timeout: 5))
		search.typeText("expired")
		XCTAssertTrue(expired.waitForExistence(timeout: 10))
		shot("search")
		search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 7) + "password")
		XCTAssertTrue(app.staticTexts["No Results for \u{201C}password\u{201D}"].waitForExistence(timeout: 10))
		app.buttons["Everywhere"].tap()
		XCTAssertTrue(app.staticTexts["Password reset restores access"].waitForExistence(timeout: 10))
		XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'suite-case-'")).count, 1)
		// A result opens over the search, and going back finds the search as it was.
		app.staticTexts["Password reset restores access"].tap()
		XCTAssertTrue(app.staticTexts["case-version"].waitForExistence(timeout: 10))
		swipeBack(app)
		XCTAssertTrue(app.staticTexts["Password reset restores access"].waitForExistence(timeout: 5))
		XCTAssertEqual(search.value as? String, "password")
		// Closing the search goes back to the folder, and the next search starts empty.
		app.buttons["Close"].tap()
		XCTAssertTrue(app.buttons["suite-search"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.navigationBars["Coupons"].exists)
		app.buttons["suite-search"].tap()
		XCTAssertTrue(search.waitForExistence(timeout: 5))
		XCTAssertNotEqual(search.value as? String, "password")
		app.buttons["Close"].tap()
		XCTAssertTrue(app.buttons["suite-search"].waitForExistence(timeout: 5))
		// A tag is browsed from the top of the tab.
		swipeBack(app)
		swipeBack(app)
		XCTAssertTrue(app.buttons["tag-regression"].waitForExistence(timeout: 5))
		app.buttons["tag-regression"].tap()
		XCTAssertTrue(app.navigationBars["#regression"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'suite-case-'")).element(boundBy: 2)
			.waitForExistence(timeout: 10))
		XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'suite-case-'")).count, 3)
		shot("tag")
		swipeBack(app)
		app.buttons["folder-Checkout"].tap()
		app.buttons["folder-Checkout/Coupons"].tap()
		app.buttons["suite-new"].tap()
		let title = app.textFields["editor-title"]
		XCTAssertTrue(title.waitForExistence(timeout: 5))
		title.tap()
		title.typeText(String(repeating: "x", count: 301))
		XCTAssertFalse(app.buttons["editor-save"].isEnabled)
		XCTAssertTrue(app.staticTexts["301/300 UTF-16 units"].exists)
		shot("title-limit")
		title.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 301))
		title.typeText("Coupon can be removed")
		addStep(app, action: "Apply SAVE10", expected: "Total is lower")
		addStep(app, action: "Remove SAVE10", expected: "Total returns")
		app.swipeDown()
		shot("editor")
		app.buttons["editor-cancel"].tap()
		XCTAssertTrue(app.buttons["Discard"].waitForExistence(timeout: 5))
		app.buttons["Keep editing"].tap()
		// The draft remains after the app goes to the background.
		XCUIDevice.shared.press(.home)
		app.activate()
		XCTAssertEqual(app.textFields["editor-title"].value as? String, "Coupon can be removed")
		app.buttons["editor-save"].tap()
		XCTAssertTrue(app.staticTexts["case-version"].waitForExistence(timeout: 15))
		XCTAssertEqual(app.staticTexts["case-version"].label, "Version 1")
		XCTAssertTrue(app.staticTexts["Checkout/Coupons"].exists)
		XCTAssertFalse(app.buttons["case-edit"].exists)
		app.buttons["case-current"].tap()
		XCTAssertTrue(app.buttons["case-edit"].waitForExistence(timeout: 10))
		app.buttons["case-edit"].tap()
		XCTAssertTrue(title.waitForExistence(timeout: 10))
		let pre = app.textFields["editor-pre"]
		pre.tap()
		pre.typeText("Start with an empty cart")
		addStep(app, action: "Reload the cart", expected: "The coupon stays removed")
		XCTAssertTrue(app.buttons["editor-save"].isEnabled)
		app.buttons["editor-save"].tap()
		let savedVersion = app.staticTexts["case-version"]
		XCTAssertTrue(savedVersion.wait(for: \.label, toEqual: "Version 2", timeout: 15))
		app.buttons["case-history"].tap()
		XCTAssertTrue(app.buttons["history-version-1"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.buttons["history-version-2"].exists)
		shot("history")
		app.buttons["history-version-1"].tap()
		XCTAssertTrue(app.staticTexts["Coupon can be removed"].waitForExistence(timeout: 10))
		XCTAssertEqual(app.staticTexts["case-version"].label, "Version 1")
		XCTAssertFalse(app.buttons["case-edit"].exists)
	}
	@MainActor private func operation(_ project: String, _ name: String, _ input: [String: Any]) async throws -> Any {
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		let path = name == "admin" ? "/api/admin" : "/api/p/\(project)/\(name)"
		var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)\(path)")))
		request.httpMethod = "POST"
		request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.httpBody = try JSONSerialization.data(withJSONObject: input)
		let (data, _) = try await URLSession.shared.data(for: request)
		let reply = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
		XCTAssertEqual(reply["ok"] as? Bool, true)
		return try XCTUnwrap(reply["result"])
	}

	@MainActor private func replaceParagraph(_ field: XCUIElement, with text: String) {
		field.tap()
		field.typeKey("a", modifierFlags: .command)
		field.typeText(XCUIKeyboardKey.delete.rawValue)
		// An empty field reports its placeholder as its value.
		let empty = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == '' OR value == placeholderValue"), object: field)
		guard XCTWaiter.wait(for: [empty], timeout: 5) == .completed else {
			XCTFail("Could not clear \(field.identifier); its value is \(String(describing: field.value))")
			return
		}
		field.typeText(text)
		let replaced = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", text), object: field)
		XCTAssertEqual(XCTWaiter.wait(for: [replaced], timeout: 5), .completed,
			"Expected \(field.identifier) to contain \(text); its value is \(String(describing: field.value))")
	}

	@MainActor func testFollowAcceptedCaseProposal() async throws {
		XCUIDevice.shared.orientation = .portrait
		let project = try await makeProject()
		let rawPolicy = try await operation(project, "propose", ["edits": [["op": "policy", "preset": "strict", "unlinked": "ask"]]])
		let policyRef = try XCTUnwrap((rawPolicy as? [String: Any])?["question"] as? String)
		func decide(_ ref: String) async throws -> [[String: Any]] {
			let raw = try await operation(project, "get", ["refs": [ref]])
			let question = try XCTUnwrap((raw as? [[String: Any]])?.first)
			let result = try await operation(project, "decide", ["q": ref,
				"onEvidence": try XCTUnwrap(question["evidenceHash"] as? String),
				"answer": ["is": "accept"], "reason": "Reviewed the submitted case"])
			let rows = try XCTUnwrap(result as? [[String: Any]])
			XCTAssertEqual(rows.first?["status"] as? String, "decided")
			return rows
		}
		_ = try await decide(policyRef)
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)
		app.openProject(project)
		app.openTab("Cases")
		XCTAssertTrue(app.buttons["folder-Checkout"].waitForExistence(timeout: 10))
		app.buttons["folder-Checkout"].tap()
		app.buttons["folder-Checkout/Coupons"].tap()
		XCTAssertTrue(app.buttons["suite-new"].waitForExistence(timeout: 10))
		app.buttons["suite-new"].tap()
		let title = app.textFields["editor-title"]
		XCTAssertTrue(title.waitForExistence(timeout: 10))
		title.tap(); title.typeText("Continue the accepted phone case")
		app.buttons["editor-save"].tap()
		let notice = app.staticTexts["editor-notice"]
		XCTAssertTrue(notice.waitForExistence(timeout: 10))
		shot("proposal-waiting")
		let rawInbox = try await operation(project, "inbox", ["kind": "adopt", "state": "open"])
		let inbox = try XCTUnwrap(rawInbox as? [String: Any])
		let question = try XCTUnwrap((inbox["items"] as? [[String: Any]])?.first)
		let questionRef = try XCTUnwrap(question["q"] as? String)
		let decided = try await decide(questionRef)
		let effects = try XCTUnwrap(decided.first?["effects"] as? [String: Any])
		let saved = try XCTUnwrap((effects["cases"] as? [[String: Any]])?.first)
		let ref = try XCTUnwrap(saved["ref"] as? String)
		let followed = app.navigationBars["Edit \(ref)"]
		let didFollow = followed.waitForExistence(timeout: 10)
		shot("proposal-followed")
		XCTAssertTrue(didFollow)
		XCTAssertEqual(title.value as? String, "Continue the accepted phone case")
		XCTAssertTrue(title.isEnabled)
		replaceParagraph(title, with: "Continue with phone title edit")
		app.buttons["editor-save"].tap()
		let waiting = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS 'waits for a person'"), object: notice)
		XCTAssertEqual(XCTWaiter.wait(for: [waiting], timeout: 10), .completed)
		let rawNext = try await operation(project, "inbox", ["kind": "adopt", "state": "open"])
		let next = try XCTUnwrap(((rawNext as? [String: Any])?["items"] as? [[String: Any]])?.first?["q"] as? String)
		let other = try await operation(project, "propose", ["edits": [[
			"op": "edit", "case": ref, "base": 1,
			"body": ["pre": "Their accepted precondition", "methods": ["human", "agent"], "automate": "wanted"],
		]]])
		let otherQuestion = try XCTUnwrap((other as? [String: Any])?["question"] as? String)
		_ = try await decide(otherQuestion)
		let edited = try await decide(next)
		let editedEffects = try XCTUnwrap(edited.first?["effects"] as? [String: Any])
		let version = try XCTUnwrap((editedEffects["cases"] as? [[String: Any]])?.first)
		XCTAssertEqual(version["ref"] as? String, ref)
		XCTAssertEqual(version["version"] as? Int, 3)
		let refreshed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS 'version 3'"), object: notice)
		let didRefresh = await XCTWaiter.fulfillment(of: [refreshed], timeout: 10)
		shot("proposal-followed-merged-editor")
		XCTAssertEqual(didRefresh, .completed)
		XCTAssertTrue(title.isEnabled)
		XCTAssertEqual(app.textFields["editor-pre"].value as? String, "Their accepted precondition")
		XCTAssertTrue(notice.label.contains("includes changes you did not make. Read it before editing again."))
		app.buttons["editor-cancel"].tap()
		XCTAssertTrue(app.staticTexts["Continue with phone title edit"].waitForExistence(timeout: 10))
		app.staticTexts["Continue with phone title edit"].tap()
		XCTAssertTrue(app.staticTexts["case-version"].waitForExistence(timeout: 10))
		shot("proposal-case-merged-version-three")
		let rawCases = try await operation(project, "find", ["in": "cases", "text": "Continue"])
		let cases = try XCTUnwrap((rawCases as? [String: Any])?["items"] as? [[String: Any]])
		XCTAssertEqual(cases.compactMap { $0["ref"] as? String }, [ref])
	}

	@MainActor func testMethodBadges() async throws {
		try await checkMethodBadges(category: .large, name: "default")
		try await checkMethodBadges(category: .accessibilityLarge, name: "accessibility")
	}

	@MainActor private func checkMethodBadges(category: UIContentSizeCategory, name: String) async throws {
		XCUIDevice.shared.orientation = .portrait
		let project = try await makeProject()
		let rawFound = try await operation(project, "find", ["in": "cases", "text": "Expired coupon"])
		let found = try XCTUnwrap(rawFound as? [String: Any])
		let item = try XCTUnwrap((found["items"] as? [[String: Any]])?.first)
		let ref = try XCTUnwrap(item["ref"] as? String)
		let body: [String: Any] = ["title": "Expired coupon is rejected", "pre": "",
			"steps": [["id": "s1", "action": "Open cart", "expected": NSNull()]],
			"methods": ["human", "auto"], "automate": "none"]
		_ = try await operation(project, "propose", ["edits": [["op": "edit", "case": ref, "base": 1, "body": body]]])
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"]),
			"-UIPreferredContentSizeCategoryName", category.rawValue]
		app.launch()
		try signIn(app)
		app.openProject(project)
		app.openTab("Cases")
		XCTAssertTrue(app.buttons["folder-Checkout"].waitForExistence(timeout: 10))
		app.buttons["folder-Checkout"].tap()
		app.buttons["folder-Checkout/Coupons"].tap()
		let title = app.staticTexts["Expired coupon is rejected"]
		XCTAssertTrue(title.waitForExistence(timeout: 10))
		title.tap()
		let caseFrames = methodBadgeFrames(app)
		shot("methods-case-\(name)")
		let edit = app.buttons["case-edit"]
		for _ in 0..<6 where !edit.isHittable { app.swipeUp() }
		XCTAssertTrue(edit.isHittable)
		edit.tap()
		let field = app.textFields["editor-title"]
		XCTAssertTrue(field.waitForExistence(timeout: 10))
		replaceParagraph(field, with: "My phone title")
		var current = body
		current["title"] = "Current phone title"
		_ = try await operation(project, "propose", ["edits": [["op": "edit", "case": ref, "base": 2, "body": current]]])
		app.buttons["editor-save"].tap()
		let mine = app.buttons["conflict-mine-title"]
		XCTAssertTrue(mine.waitForExistence(timeout: 10))
		mine.tap()
		let conflictFrames = methodBadgeFrames(app)
		shot("methods-conflict-\(name)")
		let font = UIFont.preferredFont(forTextStyle: .subheadline,
			compatibleWith: UITraitCollection(preferredContentSizeCategory: category))
		continueAfterFailure = true
		defer { continueAfterFailure = false }
		for (page, frames) in [("case", caseFrames), ("conflict", conflictFrames)] {
			for (method, frame) in frames {
				let (label, symbol) = ["human": ("Person", "person.fill"), "auto": ("Pipeline", "gearshape.2.fill"),
					"agent": ("Agent", "sparkles")][method]!
				let textWidth = (label as NSString).size(withAttributes: [.font: font]).width
				XCTAssertGreaterThanOrEqual(frame.width, ceil(textWidth) + 16,
					"\(page) \(method) must have room for its visible label at \(name)")
				// Selectable case text exposes expanded accessibility frames. Form chips expose their visual bounds.
				if page == "conflict" {
					let configuration = UIImage.SymbolConfiguration(pointSize: font.pointSize,
						weight: method == "agent" ? .regular : .semibold, scale: .medium)
					let icon = try XCTUnwrap(UIImage(systemName: symbol, withConfiguration: configuration))
					let singleLineHeight = ceil(max(font.lineHeight, icon.size.height)) + 8 + 1
					print("method-badge \(name) \(method): \(frame.width)x\(frame.height), one-line limit \(singleLineHeight)")
					XCTAssertLessThanOrEqual(frame.height, singleLineHeight,
						"\(page) \(method) must fit one text/icon line plus vertical padding at \(name)")
				}
				XCTAssertGreaterThanOrEqual(frame.minX, 0)
				XCTAssertLessThanOrEqual(frame.maxX, app.frame.maxX)
			}
		}
	}

	@MainActor private func methodBadgeFrames(_ app: XCUIApplication) -> [(String, CGRect)] {
		let agent = app.descendants(matching: .any)["method-agent"].firstMatch
		for _ in 0..<8 where !agent.isHittable { app.swipeUp() }
		app.swipeUp()
		return [("human", "A person may run it"), ("auto", "A pipeline may run it"),
			("agent", "An agent may not run it")].map { method, label in
			let chip = app.descendants(matching: .any)["method-\(method)"].firstMatch
			XCTAssertTrue(chip.exists)
			XCTAssertTrue(chip.isHittable)
			XCTAssertEqual(chip.label, label)
			return (method, chip.frame)
		}
	}

	@MainActor func testResolveOverlappingEdit() async throws {
		XCUIDevice.shared.orientation = .portrait
		let project = try await makeProject()
		let rawPolicy = try await operation(project, "admin", ["do": "policy.show", "project": project])
		let policy = try XCTUnwrap(rawPolicy as? [String: Any])
		var clauses = try XCTUnwrap(policy["clauses"] as? [[String: Any]])
		let conflictClause = try XCTUnwrap(clauses.firstIndex { $0["id"] as? String == "adopt-conflict" })
		var ask = try XCTUnwrap(clauses[conflictClause]["ask"] as? [String: Any])
		ask["reason"] = "required"; clauses[conflictClause]["ask"] = ask
		let rawProposal = try await operation(project, "propose", ["edits": [["op": "policy",
			"base": try XCTUnwrap(policy["version"] as? Int), "clauses": clauses]]])
		let proposal = try XCTUnwrap(rawProposal as? [String: Any])
		let policyQuestion = try XCTUnwrap(proposal["question"] as? String)
		let rawQuestion = try await operation(project, "get", ["refs": [policyQuestion]])
		let question = try XCTUnwrap((rawQuestion as? [[String: Any]])?.first)
		let rawAdopted = try await operation(project, "decide", ["q": policyQuestion,
			"onEvidence": try XCTUnwrap(question["evidenceHash"] as? String), "answer": ["is": "accept"]])
		XCTAssertEqual((rawAdopted as? [[String: Any]])?.first?["status"] as? String, "decided")
		let rawFound = try await operation(project, "find", ["in": "cases", "text": "Expired coupon"])
		let found = try XCTUnwrap(rawFound as? [String: Any])
		let item = try XCTUnwrap((found["items"] as? [[String: Any]])?.first)
		let ref = try XCTUnwrap(item["ref"] as? String)
		let rawRows = try await operation(project, "get", ["refs": [ref]])
		let rows = try XCTUnwrap(rawRows as? [[String: Any]])
		let document = try XCTUnwrap(rows.first)
		var steps = try XCTUnwrap(document["steps"] as? [[String: Any]])
		let step = try XCTUnwrap(steps.first?["id"] as? String)
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)
		app.openProject(project)
		app.openTab("Cases")
		XCTAssertTrue(app.buttons["folder-Checkout"].waitForExistence(timeout: 10))
		app.buttons["folder-Checkout"].tap(); app.buttons["folder-Checkout/Coupons"].tap()
		XCTAssertTrue(app.staticTexts["Expired coupon is rejected"].waitForExistence(timeout: 10))
		app.staticTexts["Expired coupon is rejected"].tap()
		XCTAssertTrue(app.buttons["case-edit"].waitForExistence(timeout: 10))
		app.buttons["case-edit"].tap()
		let title = app.textFields["editor-title"]
		XCTAssertTrue(title.waitForExistence(timeout: 10))
		replaceParagraph(title, with: "My phone title")
		let action = app.textFields["editor-action-\(step)"]
		replaceParagraph(action, with: "My phone action")
		steps[0]["action"] = "Their phone action"
		_ = try await operation(project, "propose", ["edits": [["op": "edit", "case": ref, "base": 1,
			"body": ["title": "Current phone title", "pre": "Concurrent precondition", "steps": steps]]]])
		app.buttons["editor-save"].tap()
		let myTitle = app.buttons["conflict-mine-title"]
		XCTAssertTrue(myTitle.waitForExistence(timeout: 10))
		XCTAssertFalse(app.buttons["editor-save"].isEnabled)
		shot("conflict")
		myTitle.tap()
		let theirAction = app.buttons["conflict-current-Step ^\(step) action"]
		for _ in 0..<5 where !theirAction.isHittable { app.swipeUp() }
		XCTAssertTrue(theirAction.exists)
		theirAction.tap()
		XCTAssertFalse(app.buttons["editor-save"].isEnabled)
		let reason = app.textFields["conflict-reason"]
		for _ in 0..<5 where !reason.isHittable { app.swipeUp() }
		XCTAssertTrue(reason.exists)
		XCTAssertTrue(app.staticTexts["Reason required"].exists)
		shot("conflict-reason-required")
		reason.tap()
		reason.typeText("I combined my title with the current action")
		XCUIDevice.shared.press(.home); app.activate()
		XCTAssertEqual(reason.value as? String, "I combined my title with the current action")
		XCTAssertTrue(app.buttons["editor-save"].isEnabled)
		shot("conflict-chosen")
		app.buttons["editor-save"].tap()
		XCTAssertTrue(app.staticTexts["case-version"].waitForExistence(timeout: 15))
		XCTAssertEqual(app.staticTexts["case-version"].label, "Version 3")
		XCTAssertTrue(app.staticTexts["My phone title"].exists)
		XCTAssertTrue(app.staticTexts["1. Their phone action"].exists)
		XCTAssertTrue(app.staticTexts["Concurrent precondition"].exists)
		shot("conflict-saved")
	}

}
