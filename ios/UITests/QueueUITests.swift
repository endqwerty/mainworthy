import XCTest

/// A project of a test's own, filled by `scripts/ios/scenario.ts`. Its key is also its name.
private func makeProject(strict: Bool = false) async throws -> String {
	let environment = ProcessInfo.processInfo.environment
	let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"], "run this with `bun scripts/ios.ts uitest`")
	var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)/test/project")))
	request.httpMethod = "POST"
	request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
	request.httpBody = Data((strict ? #"{"kind":"strict"}"# : "{}").utf8)
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
		XCTAssertTrue(app.buttons["project-menu"].waitForExistence(timeout: 20))
	}

	@MainActor private func dropConfirmation(in app: XCUIApplication) -> XCUIElement {
		let confirm = app.buttons.matching(
			NSPredicate(format: "label == %@ AND identifier != %@", "Drop saved answer", "drop-saved-answer")
		).firstMatch
		XCTAssertTrue(confirm.waitForExistence(timeout: 5))
		return confirm
	}

	@MainActor private func call(_ operation: String, project: String, input: [String: Any]) async throws -> [String: Any] {
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)/api/p/\(project)/\(operation)")))
		request.httpMethod = "POST"
		request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.httpBody = try JSONSerialization.data(withJSONObject: input)
		let (data, response) = try await URLSession.shared.data(for: request)
		XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(decoding: data, as: UTF8.self))
		let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
		if let result = envelope["result"] as? [String: Any] { return result }
		return ["items": try XCTUnwrap(envelope["result"] as? [Any])]
	}

	@MainActor private func launchAtTextSize(_ size: UIContentSizeCategory, project: String) throws -> XCUIApplication {
		XCUIDevice.shared.orientation = .portrait
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"]),
			"-UIPreferredContentSizeCategoryName", size.rawValue]
		app.launch()
		try signIn(app)
		app.openProject(project)
		return app
	}

	@MainActor private func assertWholeWord(_ word: String, in text: XCUIElement,
		style: UIFont.TextStyle, size: UIContentSizeCategory, weight: UIFont.Weight = .regular,
		window: CGRect, file: StaticString = #filePath, line: UInt = #line) {
		let traits = UITraitCollection(preferredContentSizeCategory: size)
		let preferred = UIFont.preferredFont(forTextStyle: style, compatibleWith: traits)
		let font = UIFont.systemFont(ofSize: preferred.pointSize, weight: weight)
		let width = (word as NSString).size(withAttributes: [.font: font]).width
		print("u706 \(word): frame=\(text.frame), whole-word width=\(width), font=\(font.pointSize), window=\(window)")
		XCTAssertGreaterThanOrEqual(text.frame.width, width - 1, "\(word) must fit without truncation or a mid-word break", file: file, line: line)
		XCTAssertGreaterThanOrEqual(text.frame.minX, window.minX, file: file, line: line)
		XCTAssertLessThanOrEqual(text.frame.maxX, window.maxX, file: file, line: line)
	}

	@MainActor private func listRows(at size: UIContentSizeCategory, name: String) async throws {
		let project = try await makeProject()
		let inbox = try await call("inbox", project: project, input: ["kind": "failure"])
		let question = try XCTUnwrap((inbox["items"] as? [[String: Any]])?.first)
		let ref = try XCTUnwrap(question["q"] as? String)
		let app = try launchAtTextSize(size, project: project)
		let window = app.windows.firstMatch.frame
		let queue = app.buttons["question-\(ref)"]
		XCTAssertTrue(queue.waitForExistence(timeout: 10))
		continueAfterFailure = true
		defer { continueAfterFailure = false }

		func fits(_ row: XCUIElement) {
			XCTAssertGreaterThanOrEqual(row.frame.minX, window.minX)
			XCTAssertLessThanOrEqual(row.frame.maxX, window.maxX)
			for text in row.staticTexts.allElementsBoundByIndex {
				print("u714 \(name) \(text.label): \(text.frame)")
				XCTAssertGreaterThanOrEqual(text.frame.minX, window.minX, text.label)
				XCTAssertLessThanOrEqual(text.frame.maxX, window.maxX, text.label)
			}
		}
		func time(in row: XCUIElement) -> XCUIElement {
			let text = row.staticTexts.matching(NSPredicate(format: "label CONTAINS 'ago' OR label CONTAINS 'now'")).firstMatch
			XCTAssertTrue(text.exists, row.debugDescription)
			return text
		}
		func completeLines(_ count: Int, in text: XCUIElement, style: UIFont.TextStyle) {
			let font = UIFont.preferredFont(forTextStyle: style,
				compatibleWith: UITraitCollection(preferredContentSizeCategory: size))
			XCTAssertGreaterThanOrEqual(text.frame.height, CGFloat(count) * font.pointSize,
				"The complete \(text.label) needs \(count) lines at AX5")
		}
		func wholeTime(_ text: XCUIElement, style: UIFont.TextStyle) {
			for word in text.label.split(separator: " ") {
				assertWholeWord(String(word), in: text, style: style, size: size, window: window)
			}
		}

		shot("u714-\(name)-queue")
		let kind = queue.staticTexts["failure"]
		let timestamp = time(in: queue)
		assertWholeWord("failure", in: kind, style: .caption1, size: size, weight: .semibold, window: window)
		let blocking = queue.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'blocks '")).firstMatch
		XCTAssertTrue(blocking.exists)
		assertWholeWord("blocks", in: blocking, style: .caption1, size: size, weight: .semibold, window: window)
		wholeTime(timestamp, style: .caption1)
		assertWholeWord("expected", in: queue.staticTexts[try XCTUnwrap(question["title"] as? String)],
			style: .body, size: size, window: window)
		fits(queue)
		if size == .large {
			XCTAssertEqual(kind.frame.midY, timestamp.frame.midY, accuracy: 3)
			XCTAssertLessThan(kind.frame.maxX, blocking.frame.minX)
			XCTAssertLessThan(blocking.frame.maxX, timestamp.frame.minX)
		}

		app.buttons["queue-select"].tap()
		let selection = app.buttons["select-\(ref)"]
		XCTAssertTrue(selection.waitForExistence(timeout: 5))
		shot("u714-\(name)-queue-selection")
		assertWholeWord("failure", in: selection.staticTexts["failure"], style: .caption1, size: size, weight: .semibold, window: window)
		let selectedTime = time(in: selection)
		wholeTime(selectedTime, style: .caption1)
		if size == .accessibilityExtraExtraExtraLarge,
			selectedTime.label.range(of: "^[0-9]{2} seconds ago$", options: .regularExpression) != nil {
			let font = UIFont.preferredFont(forTextStyle: .caption1,
				compatibleWith: UITraitCollection(preferredContentSizeCategory: size))
			XCTAssertGreaterThanOrEqual(selectedTime.frame.height, 2 * font.lineHeight - 1,
				"The selected row's time must wrap instead of truncating its last word")
		}
		assertWholeWord("expected", in: selection.staticTexts[try XCTUnwrap(question["title"] as? String)],
			style: .body, size: size, window: window)
		fits(selection)
		app.buttons["queue-select"].tap()

		app.openTab("Runs")
		let run = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Checkout regression'")).firstMatch
		XCTAssertTrue(run.waitForExistence(timeout: 10))
		shot("u714-\(name)-runs")
		let verdict = run.staticTexts["blocked"]
		assertWholeWord("blocked", in: verdict, style: .caption1, size: size, weight: .semibold, window: window)
		let state = run.staticTexts["open"]
		assertWholeWord("open", in: state, style: .caption1, size: size, window: window)
		wholeTime(time(in: run), style: .subheadline)
		let detail = run.staticTexts.matching(NSPredicate(format: "label CONTAINS 'in progress'")).firstMatch
		assertWholeWord("progress", in: detail, style: .subheadline, size: size, window: window)
		fits(run)
		if size == .large {
			XCTAssertEqual(verdict.frame.midY, state.frame.midY, accuracy: 3)
			XCTAssertEqual(detail.frame.midY, time(in: run).frame.midY, accuracy: 3)
		}

		if size == .accessibilityExtraExtraExtraLarge {
			func reveal(_ text: XCUIElement) {
				for _ in 0..<8 where text.frame.maxY > window.maxY - 100 {
					app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
						.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55)))
				}
				XCTAssertTrue(text.isHittable)
			}
			let timestamp = time(in: run)
			reveal(timestamp)
			shot("u714-\(name)-runs-time")
			let changeRun = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Apply a percentage coupon'")).firstMatch
			XCTAssertTrue(changeRun.exists)
			let heading = changeRun.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'pr:482'")).firstMatch
			XCTAssertTrue(heading.label.contains("percentage"), heading.label)
			assertWholeWord("percentage", in: heading,
				style: .headline, size: size, weight: .semibold, window: window)
			completeLines(4, in: heading, style: .headline)
			let detail = changeRun.staticTexts["Apply a percentage coupon"]
			assertWholeWord("percentage", in: detail, style: .subheadline, size: size, window: window)
			completeLines(3, in: detail, style: .subheadline)
			fits(changeRun)
			reveal(heading)
			shot("u714-\(name)-runs-change")
			reveal(detail)
			shot("u714-\(name)-runs-detail")
		}

		app.openTab("Changes")
		let change = app.buttons["change-pr:482"]
		XCTAssertTrue(change.waitForExistence(timeout: 10))
		shot("u714-\(name)-changes")
		let title = change.staticTexts["Apply a percentage coupon"]
		assertWholeWord("percentage", in: title, style: .body, size: size, weight: .medium, window: window)
		assertWholeWord("blocked", in: change.staticTexts["blocked"], style: .caption1, size: size, weight: .semibold, window: window)
		fits(change)
		if size == .accessibilityExtraExtraExtraLarge {
			completeLines(3, in: title, style: .body)
		}
		if size == .large {
			XCTAssertEqual(title.frame.midY, change.staticTexts["blocked"].frame.midY, accuracy: 3)
		}
	}

	@MainActor func testListRowsKeepWordsWholeAtLargestTextSize() async throws {
		try await listRows(at: .accessibilityExtraExtraExtraLarge, name: "ax5")
	}

	@MainActor func testListRowsKeepWordsWholeAtXXXLarge() async throws {
		try await listRows(at: .extraExtraExtraLarge, name: "xxxl")
	}

	@MainActor func testListRowsKeepDefaultLayout() async throws {
		try await listRows(at: .large, name: "default")
	}

	@MainActor private func proposalSource(at size: UIContentSizeCategory, name: String) async throws {
		let project = try await makeProject()
		let app = try launchAtTextSize(size, project: project)
		let proposal = app.staticTexts["Edit: A percentage coupon lowers the total"]
		for _ in 0..<10 where !proposal.isHittable { app.swipeUp() }
		XCTAssertTrue(proposal.isHittable)
		proposal.tap()
		XCTAssertTrue(app.staticTexts["edit-summary"].waitForExistence(timeout: 10))
		let source = app.staticTexts["from an agent"]
		XCTAssertTrue(source.exists)
		shot("u706-\(name)-header")
		assertWholeWord("from an agent", in: source, style: .caption1, size: size, window: app.windows.firstMatch.frame)
		if size == .large {
			XCTAssertEqual(source.frame.midY, app.staticTexts["proposal"].frame.midY, accuracy: 3)
		}
	}

	@MainActor func testProposalSourceIsWholeAtXXXLarge() async throws {
		try await proposalSource(at: .extraExtraExtraLarge, name: "xxxl")
	}

	@MainActor func testProposalHeaderKeepsDefaultRow() async throws {
		try await proposalSource(at: .large, name: "default")
	}

	@MainActor func testDecidedAndTestWordsFitAtLargestTextSize() async throws {
		let project = try await makeProject()
		let inbox = try await call("inbox", project: project, input: ["kind": "failure"])
		let question = try XCTUnwrap((inbox["items"] as? [[String: Any]])?.first)
		_ = try await call("decide", project: project, input: [
			"q": try XCTUnwrap(question["q"]), "onEvidence": try XCTUnwrap(question["evidenceHash"]),
			"answer": ["is": "infra"],
		])
		let size = UIContentSizeCategory.accessibilityExtraExtraExtraLarge
		let app = try launchAtTextSize(size, project: project)
		app.buttons["Decided"].tap()
		let row = app.staticTexts[try XCTUnwrap(question["title"] as? String)]
		XCTAssertTrue(row.waitForExistence(timeout: 10))
		row.tap()
		let test = app.staticTexts["Shop check 1"]
		for _ in 0..<15 where !test.isHittable { app.swipeUp() }
		XCTAssertTrue(test.isHittable)
		shot("u706-ax5-tests")
		let testFrame = test.frame
		let decision = app.staticTexts["Infrastructure"]
		for _ in 0..<10 where !decision.isHittable { app.swipeUp() }
		XCTAssertTrue(decision.isHittable)
		shot("u706-ax5-decided")
		continueAfterFailure = true
		defer { continueAfterFailure = false }
		let window = app.windows.firstMatch.frame
		assertWholeWord("Infrastructure", in: decision, style: .body, size: size, weight: .semibold, window: window)
		// The text may scroll out of view; its original rendered frame still establishes available word width.
		let font = UIFont.preferredFont(forTextStyle: .subheadline, compatibleWith: UITraitCollection(preferredContentSizeCategory: size))
		let wordWidth = ("check" as NSString).size(withAttributes: [.font: font]).width
		print("u706 check: frame=\(testFrame), whole-word width=\(wordWidth)")
		XCTAssertGreaterThanOrEqual(testFrame.width, wordWidth - 1, "check must fit without a mid-word break")
		XCTAssertGreaterThanOrEqual(testFrame.minX, window.minX)
		XCTAssertLessThanOrEqual(testFrame.maxX, window.maxX)
	}

	@MainActor func testProposalFitsScreenAtLargestTextSize() async throws {
		XCUIDevice.shared.orientation = .portrait
		let project = try await makeProject()
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"]),
			"-UIPreferredContentSizeCategoryName", UIContentSizeCategory.accessibilityExtraExtraExtraLarge.rawValue]
		app.launch()
		try signIn(app)
		app.openProject(project)
		let proposal = app.staticTexts["Edit: A percentage coupon lowers the total"]
		for _ in 0..<6 where !proposal.isHittable { app.swipeUp() }
		XCTAssertTrue(proposal.wait(for: \.isHittable, toEqual: true, timeout: 10))
		proposal.tap()
		let summary = app.staticTexts["edit-summary"]
		XCTAssertTrue(summary.waitForExistence(timeout: 10))
		let window = app.windows.firstMatch.frame
		let page = app.scrollViews.firstMatch.frame
		let header = [("question kind", app.staticTexts["proposal"].frame),
			("proposal reason", app.staticTexts["Check removing the coupon as well as adding it."].frame)]
		shot("u667-ax5-header")
		let picker = app.segmentedControls["edit-side"]
		for _ in 0..<8 where !picker.isHittable { app.swipeUp() }
		XCTAssertTrue(picker.isHittable)
		shot("u667-ax5-evidence")
		let evidence = [("edit summary", summary.frame), ("side picker", picker.frame)]
		picker.buttons["Current"].tap()
		var chips: [(String, CGRect)] = []
		for method in ["human", "auto", "agent"] {
			let chip = app.descendants(matching: .any)["method-\(method)"].firstMatch
			for _ in 0..<10 where !chip.isHittable { app.swipeUp() }
			XCTAssertTrue(chip.isHittable)
			chips.append((method, chip.frame))
		}
		shot("u667-ax5-methods")
		continueAfterFailure = true
		defer { continueAfterFailure = false }
		// Allow subpoint rounding on the container; the content edges below must fit exactly.
		XCTAssertEqual(page.minX, window.minX, accuracy: 0.5)
		XCTAssertEqual(page.maxX, window.maxX, accuracy: 0.5)
		for (name, frame) in header + evidence + chips {
			print("u667 AX5 \(name): \(frame), window: \(window)")
			XCTAssertGreaterThanOrEqual(frame.minX, window.minX, "\(name) leading edge must fit the window")
			XCTAssertLessThanOrEqual(frame.maxX, window.maxX, "\(name) trailing edge must fit the window")
		}
	}

	@MainActor func testLargeContentProposalCanBeReadAndAnswered() async throws {
		let project = try await makeProject(strict: true)
		let edits: [[String: Any]] = (1...21).map { index in
			["op": "create", "body": ["title": "Large proposal case \(index)", "steps": []]]
		}
		let proposed = try await call("propose", project: project, input: [
			"reason": "Review all twenty-one cases.", "edits": edits,
		])
		let question = try XCTUnwrap(proposed["question"] as? String)
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)
		app.openProject(project)
		let row = app.buttons["question-\(question)"]
		XCTAssertTrue(row.waitForExistence(timeout: 10))
		row.tap()
		XCTAssertTrue(app.staticTexts.matching(identifier: "Large proposal case 1").firstMatch.waitForExistence(timeout: 10))
		let scroll = app.scrollViews.firstMatch
		let reject = app.buttons["answer-reject"]
		XCTAssertFalse(reject.isEnabled)
		shot("u696-large-proposal-unread")
		for _ in 0..<80 where !scroll.frame.contains(reject.frame) {
			let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
			start.press(forDuration: 0.02, thenDragTo: scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)), withVelocity: .slow, thenHoldForDuration: 0.05)
		}
		XCTAssertTrue(scroll.frame.contains(reject.frame))
		XCTAssertTrue(app.staticTexts.matching(identifier: "Large proposal case 21").firstMatch.exists)
		XCTAssertTrue(reject.isEnabled)
		shot("u696-large-proposal-read")
		reject.tap()
		// Strict projects require a reason for the answer.
		if app.textFields["reason"].waitForExistence(timeout: 2) {
			app.textFields["reason"].tap()
			app.textFields["reason"].typeText("Read all twenty-one cases.")
			app.buttons["submit-answer"].tap()
		}
		XCTAssertTrue(app.staticTexts["notice"].waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["notice"].label.hasSuffix(": Reject."))
		let result = try await call("get", project: project, input: ["refs": [question]])
		let settled = try XCTUnwrap((result["items"] as? [[String: Any]])?.first)
		XCTAssertEqual(settled["state"] as? String, "decided")
	}

	@MainActor func testProposalViewportCoverage() async throws {
		let project = try await makeProject(strict: true)
		let lines = (1...140).map { "Prerequisite \($0). Read this line before reviewing the proposed case." }.joined(separator: "\n")
		_ = try await call("propose", project: project, input: [
			"reason": "Review the complete tall edit.",
			"edits": [["op": "edit", "case": "C-1", "base": 1, "body": ["pre": lines]]],
		])
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)
		app.openProject(project)
		let row = app.staticTexts["Edit: The shop opens"]
		XCTAssertTrue(row.waitForExistence(timeout: 10))
		row.tap()
		XCTAssertTrue(app.staticTexts["edit-summary"].waitForExistence(timeout: 10))
		let scroll = app.scrollViews.firstMatch
		let accept = app.buttons["answer-accept"]
		// Drag the scroll indicator to jump past the middle of this single tall edit.
		scroll.swipeUp()
		let bar = scroll.otherElements.matching(NSPredicate(format: "label BEGINSWITH 'Vertical scroll bar'")).firstMatch
		XCTAssertTrue(bar.exists)
		let pages = try XCTUnwrap(bar.label.components(separatedBy: CharacterSet.decimalDigits.inverted).compactMap(Int.init).first)
		let percent = try XCTUnwrap(bar.value as? String).replacingOccurrences(of: "%", with: "")
		let progress = try XCTUnwrap(Double(percent)) / 100
		let thumb = bar.frame.height / Double(pages)
		let position = ((bar.frame.height - thumb) * progress + thumb / 2) / bar.frame.height
		let edge = bar.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: position))
		edge.press(forDuration: 0.6, thenDragTo: bar.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 1)), withVelocity: XCUIGestureVelocity(rawValue: 100_000), thenHoldForDuration: 0.1)
		XCTAssertTrue(scroll.frame.contains(accept.frame), "The indicator drag must jump directly to the answer buttons")
		shot("u8-proposal-disabled")
		XCTAssertFalse(accept.isEnabled, "Fetching a tall edit and showing its bottom must leave its unseen middle unread")
		for _ in 0..<30 where !app.staticTexts["edit-summary"].isHittable { scroll.swipeDown(velocity: .fast) }
		// Page through with overlap so every vertical range actually appears.
		for _ in 0..<45 where !scroll.frame.contains(accept.frame) {
			let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
			start.press(forDuration: 0.02, thenDragTo: scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)), withVelocity: .slow, thenHoldForDuration: 0.05)
		}
		XCTAssertTrue(scroll.frame.contains(accept.frame))
		XCTAssertTrue(accept.isEnabled)
		scroll.swipeUp()
		shot("u8-proposal-enabled")
	}

	@MainActor private func questionConnection(project: String, question: String, mode: String) async throws -> (url: String, arrived: Bool) {
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)/test/question-connection")))
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
		request.httpBody = try JSONSerialization.data(withJSONObject: ["project": project, "question": question, "mode": mode])
		let (data, response) = try await URLSession.shared.data(for: request)
		XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
		let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
		let result = try XCTUnwrap(envelope["result"] as? [String: Any])
		return (try XCTUnwrap(result["url"] as? String), try XCTUnwrap(result["arrived"] as? Bool))
	}

	@MainActor func testAcceptReasonSheetSurvivesQuestionMissingDuringRefresh() async throws {
		let project = try await makeProject(strict: true)
		let made = try await call("propose", project: project, input: [
			"reason": "Review the title.",
			"edits": [["op": "edit", "case": "C-1", "base": 1, "body": ["title": "The storefront opens"]]],
		])
		let question = try XCTUnwrap(made["question"] as? String)
		let proxy = try await questionConnection(project: project, question: question, mode: "normal")
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", proxy.url]
		app.launch()
		try signIn(app)
		app.openProject(project)
		let row = app.staticTexts["Edit: The shop opens"]
		XCTAssertTrue(row.waitForExistence(timeout: 10))
		row.tap()
		XCTAssertTrue(app.staticTexts["edit-summary"].waitForExistence(timeout: 10))
		app.swipeUp()
		app.swipeDown()
		app.swipeUp()
		XCTAssertTrue(app.buttons["answer-accept"].isEnabled)
		app.buttons["answer-accept"].tap()
		let reason = app.descendants(matching: .any)["reason"].firstMatch
		XCTAssertTrue(reason.waitForExistence(timeout: 5))
		reason.tap()
		reason.typeText("Keep this reason")
		_ = try await questionConnection(project: project, question: question, mode: "hold")
		// Failures sort ahead of proposals, pushing this still-open question past the loaded first page.
		let results: [[String: Any]] = (1...101).map { index in [
			"test": ["key": "refresh-\(index)", "name": "Refresh failure \(index)", "file": "refresh.spec.ts"],
			"outcome": "fail", "message": "Refresh failure \(index)",
		] }
		_ = try await call("report", project: project, input: [
			"target": ["commit": String(repeating: "6", count: 40), "repo": "acme/shop", "branch": "main"],
			"job": "refresh", "results": results,
		])
		var arrived = false
		for _ in 0..<100 {
			arrived = try await questionConnection(project: project, question: question, mode: "status").arrived
			if arrived { break }
			try await Task.sleep(for: .milliseconds(100))
		}
		XCTAssertTrue(arrived, "The list refresh must request the open question separately")
		let current = try await call("get", project: project, input: ["refs": [question]])
		let rows = try XCTUnwrap(current["items"] as? [[String: Any]])
		XCTAssertEqual(rows.first?["state"] as? String, "open")
		shot("u8-r2-missing-question")
		XCTAssertTrue(app.buttons["submit-answer"].exists, "A temporarily missing question must keep its open reason sheet")
		XCTAssertEqual(reason.value as? String, "Keep this reason")
		XCTAssertFalse(app.staticTexts["question-settled"].exists)
		_ = try await questionConnection(project: project, question: question, mode: "normal")
		app.buttons["Cancel"].tap()
		XCTAssertTrue(app.buttons["answer-accept"].wait(for: \.isEnabled, toEqual: true, timeout: 10))
		XCTAssertFalse(app.staticTexts["question-settled"].exists)
		shot("u8-r2-open-question")
	}

	@MainActor func testAcceptReasonSheetClosesWhenSettledElsewhere() async throws {
		let project = try await makeProject(strict: true)
		let made = try await call("propose", project: project, input: [
			"reason": "Review the title.",
			"edits": [["op": "edit", "case": "C-1", "base": 1, "body": ["title": "The storefront opens"]]],
		])
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)
		app.openProject(project)
		let row = app.staticTexts["Edit: The shop opens"]
		XCTAssertTrue(row.waitForExistence(timeout: 10))
		row.tap()
		XCTAssertTrue(app.staticTexts["edit-summary"].waitForExistence(timeout: 10))
		app.swipeUp()
		app.swipeDown()
		app.swipeUp()
		XCTAssertTrue(app.buttons["answer-accept"].isEnabled)
		shot("u8-before-accept")
		app.buttons["answer-accept"].tap()
		let reason = app.descendants(matching: .any)["reason"].firstMatch
		XCTAssertTrue(reason.waitForExistence(timeout: 5))
		reason.tap()
		reason.typeText("Reviewed here")
		let question = try XCTUnwrap(made["question"] as? String)
		let inbox = try await call("inbox", project: project, input: ["kind": "adopt"])
		let items = try XCTUnwrap(inbox["items"] as? [[String: Any]])
		let live = try XCTUnwrap(items.first { $0["q"] as? String == question })
		_ = try await call("decide", project: project, input: [
			"q": question, "onEvidence": try XCTUnwrap(live["evidenceHash"] as? String),
			"answer": ["is": "reject"], "reason": "Decided by another client",
		])
		let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["submit-answer"])
		XCTAssertEqual(XCTWaiter.wait(for: [closed], timeout: 15), .completed)
		XCTAssertTrue(app.staticTexts["This question was settled elsewhere."].waitForExistence(timeout: 5))
		XCTAssertTrue(app.staticTexts["Reject"].exists)
		shot("u8-settled-elsewhere")
	}

	@MainActor func testSettlementNoticeClearsWhenQuestionReopens() async throws {
		let project = try await makeProject()
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)
		app.openProject(project)
		let row = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'expected $90.00'")).firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 10))
		row.tap()
		let defect = app.buttons["answer-defect"]
		for _ in 0..<5 where !defect.isHittable { app.swipeUp() }
		XCTAssertTrue(defect.isEnabled)
		defect.tap()
		XCTAssertTrue(app.textFields["reference"].waitForExistence(timeout: 5))
		let inbox = try await call("inbox", project: project, input: ["kind": "failure"])
		let items = try XCTUnwrap(inbox["items"] as? [[String: Any]])
		let live = try XCTUnwrap(items.first)
		let question = try XCTUnwrap(live["q"] as? String)
		let decided = try await call("decide", project: project, input: [
			"q": question, "onEvidence": try XCTUnwrap(live["evidenceHash"] as? String),
			"answer": ["is": "infra"],
		])
		XCTAssertEqual((decided["items"] as? [[String: Any]])?.first?["status"] as? String, "decided")
		XCTAssertTrue(app.staticTexts["question-settled"].waitForExistence(timeout: 15))
		XCTAssertFalse(app.buttons["submit-answer"].exists)
		let undone = try await call("decide", project: project, input: ["undo": question])
		XCTAssertEqual((undone["items"] as? [[String: Any]])?.first?["status"] as? String, "reopened")
		XCTAssertTrue(defect.waitForExistence(timeout: 15))
		let noticeGone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.staticTexts["question-settled"])
		let cleared = await XCTWaiter.fulfillment(of: [noticeGone], timeout: 5)
		shot("u8-r2-reopened-question")
		XCTAssertEqual(cleared, .completed, "An open question must not claim it was settled elsewhere")
		XCTAssertTrue(defect.isEnabled)
	}

	@MainActor func testAcceptConfirmationClosesWhenSettledElsewhere() async throws {
		let project = try await makeProject()
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)
		app.openProject(project)
		let row = app.staticTexts["Edit: A percentage coupon lowers the total"]
		XCTAssertTrue(row.waitForExistence(timeout: 10))
		row.tap()
		XCTAssertTrue(app.staticTexts["edit-summary"].waitForExistence(timeout: 10))
		app.swipeUp()
		app.swipeDown()
		app.swipeUp()
		XCTAssertTrue(app.buttons["answer-accept"].isEnabled)
		shot("u8-before-accept")
		app.buttons["answer-accept"].tap()
		shot("u8-confirmation-open")
		XCTAssertTrue(app.staticTexts["Accept this edit?"].waitForExistence(timeout: 5))
		let inbox = try await call("inbox", project: project, input: ["kind": "adopt"])
		let items = try XCTUnwrap(inbox["items"] as? [[String: Any]])
		let live = try XCTUnwrap(items.first)
		_ = try await call("decide", project: project, input: [
			"q": try XCTUnwrap(live["q"] as? String), "onEvidence": try XCTUnwrap(live["evidenceHash"] as? String),
			"answer": ["is": "reject"],
		])
		let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.staticTexts["Accept this edit?"])
		XCTAssertEqual(XCTWaiter.wait(for: [closed], timeout: 15), .completed)
		XCTAssertTrue(app.staticTexts["This question was settled elsewhere."].waitForExistence(timeout: 5))
		shot("u8-confirmation-settled")
	}

	@MainActor func testLinkAnUnlinkedTestAndCreateACase() async throws {
		let project = try await makeProject()
		let second = try await makeProject()
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)
		app.openProject(project)
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

		app.openProject(second)
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
		app.openProject(project)
		XCTAssertTrue(app.staticTexts["1 test in tests/search.spec.ts has no case"].waitForExistence(timeout: 10))
		app.buttons["queue-select"].tap()
		let count = app.staticTexts["selection-count"]
		XCTAssertTrue(count.waitForExistence(timeout: 5))
		XCTAssertEqual(count.label, "Select questions")
		shot("bulk-select")
		let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'select-Q-'"))
		let unlinked = rows.matching(NSPredicate(format: "label CONTAINS 'has no case'"))
		XCTAssertEqual(unlinked.count, 4)
		unlinked.element(boundBy: 0).tap()
		XCTAssertEqual(count.label, "1 unlinked test selected")
		// A failure is another kind: it says so and stays out.
		let failure = rows.matching(NSPredicate(format: "label CONTAINS 'expected $90.00'")).firstMatch
		failure.tap()
		XCTAssertTrue(app.staticTexts["notice"].waitForExistence(timeout: 5))
		XCTAssertTrue(app.staticTexts["notice"].label.hasSuffix("one answer is for one kind."), app.staticTexts["notice"].label)
		XCTAssertEqual(count.label, "1 unlinked test selected")
		app.buttons["select-all"].tap()
		XCTAssertEqual(count.label, "4 unlinked tests selected")
		shot("bulk-selected")
		app.buttons["bulk-answer"].tap()
		XCTAssertFalse(app.buttons["bulk-link"].exists)
		app.buttons["bulk-track"].tap()
		let confirm = app.buttons["bulk-confirm"].firstMatch
		XCTAssertTrue(confirm.waitForExistence(timeout: 5))
		shot("bulk-confirm")
		confirm.tap()
		let notice = app.staticTexts["notice"]
		let recorded = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "4 unlinked tests: Track without a case."), object: notice)
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

		// The answer is one saved entry for its four questions, and once recorded it can be cleared.
		app.buttons["unsent-answers"].tap()
		XCTAssertTrue(app.navigationBars["Unsent answers"].waitForExistence(timeout: 10))
		let entry = app.staticTexts.matching(NSPredicate(format: "label == %@", "Track without a case for 4 questions")).firstMatch
		XCTAssertTrue(entry.waitForExistence(timeout: 5))
		XCTAssertTrue(app.staticTexts["Recorded"].exists)
		// A recorded answer is listed under Finished, and with nothing waiting there is no button to send.
		XCTAssertTrue(app.staticTexts["nothing-waiting"].exists)
		XCTAssertFalse(app.buttons["send-waiting-answers"].exists)
		XCTAssertTrue(app.staticTexts["replied-header"].exists)
		XCTAssertFalse(app.staticTexts["No reply yet"].exists)
		shot("bulk-unsent")
		let clear = app.buttons["Clear outcomes"]
		XCTAssertTrue(clear.isHittable, "Clear outcomes sits above the answers it clears, not under them")
		clear.tap()
		XCTAssertFalse(entry.waitForExistence(timeout: 2))
		XCTAssertFalse(app.staticTexts["replied-header"].exists)
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
		app.openProject(project)
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
		XCTAssertFalse(app.buttons["forget-saved-answer"].exists)
		shot("321-dropped-answer")
		app.terminate()
		app.launchArguments = ["-instance", proxy, "-answer-clock-offset", "86400"]
		app.launch()
		if app.textFields["name"].waitForExistence(timeout: 3) { try signIn(app) }
		XCTAssertTrue(app.navigationBars["Queue"].waitForExistence(timeout: 20))
		app.buttons["unsent-answers"].tap()
		XCTAssertTrue(app.staticTexts["Dropped"].waitForExistence(timeout: 10))
		let forget = app.buttons["forget-saved-answer"]
		XCTAssertTrue(forget.waitForExistence(timeout: 5))
		let canForget = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: forget)
		XCTAssertEqual(XCTWaiter.wait(for: [canForget], timeout: 10), .completed)
		shot("340-eligible")
		forget.tap()
		let confirmation = app.buttons.matching(NSPredicate(format: "label == %@ AND identifier != %@", "Forget", "forget-saved-answer")).firstMatch
		XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
		XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label == %@", "This answer may still have been recorded. If you forget it, its outcome will no longer show here. This removes the saved entry from this device.")).firstMatch.exists)
		shot("340-confirmation")
		if app.buttons["Cancel"].exists {
			app.buttons["Cancel"].tap()
		} else {
			let dismiss = app.otherElements["PopoverDismissRegion"]
			XCTAssertTrue(dismiss.exists)
			dismiss.tap()
		}
		XCTAssertTrue(app.staticTexts["Dropped"].exists)
		XCTAssertTrue(forget.exists)
		XCTAssertTrue(app.buttons["send-waiting-answers"].isEnabled)
		_ = try await connection(unavailable: false)
		app.navigationBars.buttons.element(boundBy: 0).tap()
		XCTAssertTrue(failure.waitForExistence(timeout: 10))
		failure.tap()
		app.buttons["answer-flaky"].tap()
		XCTAssertTrue(app.staticTexts["notice"].waitForExistence(timeout: 15))
		app.buttons["unsent-answers"].tap()
		// The Dropped answer has no reply and comes first; the recorded one is under Finished, below it.
		XCTAssertTrue(app.staticTexts["Dropped"].waitForExistence(timeout: 15))
		XCTAssertTrue(app.staticTexts["No reply yet"].exists)
		XCTAssertFalse(app.staticTexts["Waiting to send"].exists)
		let recorded = app.staticTexts["Recorded"]
		for _ in 0..<3 where !recorded.waitForExistence(timeout: 5) { app.swipeUp() }
		XCTAssertTrue(recorded.exists)
		XCTAssertTrue(app.staticTexts["replied-header"].exists)
		shot("206-recorded-answer")
		for _ in 0..<3 where !forget.isHittable { app.swipeDown() }
		XCTAssertTrue(forget.isHittable)
		forget.tap()
		XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
		confirmation.tap()
		let forgotten = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.staticTexts["Dropped"])
		XCTAssertEqual(XCTWaiter.wait(for: [forgotten], timeout: 5), .completed)
		XCTAssertFalse(forget.exists)
		shot("340-forgotten")
		app.terminate()
		app.launch()
		if app.textFields["name"].waitForExistence(timeout: 3) { try signIn(app) }
		XCTAssertTrue(app.navigationBars["Queue"].waitForExistence(timeout: 20))
		app.buttons["unsent-answers"].tap()
		XCTAssertTrue(app.staticTexts["Recorded"].waitForExistence(timeout: 10))
		XCTAssertFalse(app.staticTexts["Dropped"].exists)
		XCTAssertFalse(app.buttons["forget-saved-answer"].exists)
	}

	@MainActor func testPrivacyIsReachableBeforeAndAfterSignIn() async throws {
		let instance = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
		func privacyOpenings() async throws -> [String] {
			struct Reply: Decodable {
				struct Openings: Decodable { var urls: [String] }
				var result: Openings
			}
			var request = URLRequest(url: try XCTUnwrap(URL(string: "\(instance)/test/privacy-openings")))
			request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
			let (data, response) = try await URLSession.shared.data(for: request)
			XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
			return try JSONDecoder().decode(Reply.self, from: data).result.urls
		}
		func openPrivacy(_ row: XCUIElement) async throws {
			let before = try await privacyOpenings().count
			row.tap()
			XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 20))
			// Check the URL the browser actually requested, before the shared docs route redirects it.
			let deadline = Date().addingTimeInterval(20)
			var opened = try await privacyOpenings()
			while opened.count == before && Date() < deadline {
				try await Task.sleep(for: .milliseconds(100))
				opened = try await privacyOpenings()
			}
			XCTAssertEqual(Array(opened.dropFirst(before)), ["\(instance)/privacy"])
		}
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", instance]
		app.launch()
		XCTAssertTrue(app.textFields["name"].waitForExistence(timeout: 20))
		let privacy = app.descendants(matching: .any)["privacy"]
		XCTAssertTrue(privacy.waitForExistence(timeout: 5))
		XCTAssertEqual(privacy.label, "Privacy")
		shot("privacy-sign-in")
		try await openPrivacy(privacy)
		safari.terminate()
		app.activate()
		XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20))
		try signIn(app)
		app.openTab("You")
		let signedInHeading = app.staticTexts["Signed in"]
		XCTAssertTrue(signedInHeading.wait(for: \.isHittable, toEqual: true, timeout: 5))
		let accountList = app.collectionViews.firstMatch
		XCTAssertTrue(accountList.waitForExistence(timeout: 5))
		accountList.scrollUpTo(privacy)
		XCTAssertEqual(privacy.label, "Privacy")
		shot("privacy-you")
		try await openPrivacy(privacy)
		safari.terminate()
		app.activate()
		XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20))
	}

	@MainActor func testAPersonSignsInAnswersAQuestionAndTakesItBack() async throws {
		let project = try await makeProject()
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])]
		app.launch()
		try signIn(app)

		// The instance's first project is empty. The test's own is opened from the menu.
		app.openProject(project)
		let failure = app.staticTexts["expected $90.00, got $100.00"]
		XCTAssertTrue(failure.waitForExistence(timeout: 10))
		XCTAssertTrue(app.staticTexts["1 failure to explain · 3 can wait"].exists)
		shot("2-queue")
		// Open and Decided and the kinds stay under the bar: pulling to refresh moves the questions, not them.
		XCTAssertTrue(app.segmentedControls["queue-showing"].exists)
		XCTAssertFalse(app.collectionViews.firstMatch.segmentedControls["queue-showing"].exists)
		let all = NSPredicate(format: "label BEGINSWITH 'All'")
		XCTAssertTrue(app.buttons.matching(all).firstMatch.exists)
		XCTAssertFalse(app.collectionViews.firstMatch.buttons.matching(all).firstMatch.exists)

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

		// An agent's edit is shown as what it changes, before anybody accepts it: why, in a sentence what it does,
		// and the steps with the new one marked.
		app.staticTexts["Edit: A percentage coupon lowers the total"].tap()
		XCTAssertTrue(app.staticTexts["edit-summary"].waitForExistence(timeout: 10))
		XCTAssertEqual(app.staticTexts["edit-summary"].label, "Adds 1 step.")
		XCTAssertTrue(app.staticTexts["Check removing the coupon as well as adding it."].exists)
		XCTAssertTrue(app.staticTexts["Added"].exists && app.staticTexts["Remove the coupon"].exists)
		XCTAssertTrue(app.staticTexts["Expected: Total returns to $100.00"].exists)
		shot("5-proposal")
		// Read the rest of Changes before switching to the alternative renderings.
		app.swipeUp()
		app.swipeDown()
		// The case as it is, which rejecting keeps, and with the edit applied to it.
		app.segmentedControls["edit-side"].buttons["Current"].tap()
		XCTAssertTrue(app.staticTexts["Apply the coupon SAVE10"].waitForExistence(timeout: 5))
		XCTAssertFalse(app.staticTexts["Remove the coupon"].exists)
		shot("5-proposal-current")
		app.segmentedControls["edit-side"].buttons["Proposed"].tap()
		XCTAssertTrue(app.staticTexts["Remove the coupon"].waitForExistence(timeout: 5))
		XCTAssertFalse(app.staticTexts["Added"].exists)
		shot("5-proposal-proposed")
		app.swipeUp()
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
		app.collectionViews.firstMatch.scrollUpTo(app.buttons["sign-out"])
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

	@MainActor func testARefusedProposalSaysWhyUntilItIsDecided() async throws {
		let project = try await makeProject()
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		// The case gets a third step of its own while the agent's edit, which adds one too, waits.
		var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)/api/p/\(project)/propose")))
		request.httpMethod = "POST"
		request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.httpBody = try JSONSerialization.data(withJSONObject: [
			"edits": [[
				"op": "edit", "case": "C-2", "base": 1,
				"body": ["steps": [
					["id": "s1", "action": "Open the cart with one $100.00 item", "expected": NSNull()],
					["id": "s2", "action": "Apply the coupon SAVE10", "expected": "Total shows $90.00"],
					["id": "s3", "action": "A different third step", "expected": NSNull()],
				]],
			]],
		])
		let (_, response) = try await URLSession.shared.data(for: request)
		XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)

		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", address]
		app.launch()
		try signIn(app)
		app.openProject(project)
		let row = app.staticTexts.matching(identifier: "Edit: A percentage coupon lowers the total").firstMatch
		XCTAssertTrue(row.waitForExistence(timeout: 10))
		row.tap()
		// While it waits, the page says why the edit would be refused on its own, in the server's words.
		let refused = app.staticTexts["edit-refused"]
		XCTAssertTrue(refused.waitForExistence(timeout: 10))
		XCTAssertTrue(refused.label.hasPrefix("On its own, this edit would be refused: C-2 changed after this proposal was made"), refused.label)
		shot("9-proposal-refused")
		app.swipeUp()
		app.buttons["answer-reject"].tap()
		XCTAssertTrue(app.staticTexts["notice"].waitForExistence(timeout: 10))
		// Decided, it no longer says so.
		app.buttons["Decided"].tap()
		XCTAssertTrue(row.waitForExistence(timeout: 10))
		row.tap()
		XCTAssertTrue(app.segmentedControls["edit-side"].waitForExistence(timeout: 10))
		XCTAssertFalse(refused.exists)
		shot("10-proposal-decided")
	}
}
