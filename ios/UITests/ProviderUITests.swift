import XCTest

final class ProviderUITests: XCTestCase {
	private let environment = ProcessInfo.processInfo.environment

	override func setUp() { continueAfterFailure = false }

	@MainActor func testSignInThroughTheProviderInTheSystemBrowser() async throws {
		let address = try XCTUnwrap(environment["MAINWORTHY_TEST_URL"])
		var request = URLRequest(url: try XCTUnwrap(URL(string: "\(address)/test/project")))
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue("Bearer \(environment["MAINWORTHY_TEST_TOKEN"] ?? "")", forHTTPHeaderField: "Authorization")
		request.httpBody = Data(#"{"kind":"standard"}"#.utf8)
		let (_, made) = try await URLSession.shared.data(for: request)
		XCTAssertEqual((made as? HTTPURLResponse)?.statusCode, 200)
		let app = XCUIApplication()
		app.launchArguments = ["-forget", "-instance", address]
		app.launch()
		let provider = app.buttons["provider-sign-in"]
		XCTAssertTrue(provider.waitForExistence(timeout: 20))
		XCTAssertEqual(provider.label, "Sign in with Example ID")
		shot("provider-sign-in")
		provider.tap()
		let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
		let proceed = app.buttons["Continue"]
		if proceed.waitForExistence(timeout: 3) { proceed.tap() }
		else if springboard.buttons["Continue"].waitForExistence(timeout: 3) { springboard.buttons["Continue"].tap() }
		XCTAssertTrue(app.navigationBars["Queue"].waitForExistence(timeout: 25))
		shot("provider-signed-in")
		app.tabBars.buttons["You"].tap()
		XCTAssertTrue(app.navigationBars["You"].waitForExistence(timeout: 10))
		let name = environment["MAINWORTHY_TEST_NAME"] ?? "sam"
		let signedInAs = app.descendants(matching: .any).matching(
			NSPredicate(format: "label == %@ OR value == %@ OR label == %@", name, name, "Name, \(name)")
		).firstMatch
		shot("provider-account")
		XCTAssertTrue(signedInAs.waitForExistence(timeout: 10), app.debugDescription)
	}

	@MainActor private func shot(_ name: String) {
		guard let directory = environment["MAINWORTHY_SCREENSHOTS"] else { return }
		try? XCUIScreen.main.screenshot().pngRepresentation.write(
			to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png")
		)
	}
}
