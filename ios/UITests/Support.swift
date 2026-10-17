import XCTest

extension XCUIApplication {
	/// Opens a project from the menu in the bar, and waits until the menu names it: until then the menu may still
	/// be closing, and a tap on the tab bar lands on nothing.
	@MainActor func openProject(_ project: String) {
		let projectMenu = buttons["project-menu"]
		projectMenu.tap()
		let option = collectionViews.buttons[project]
		XCTAssertTrue(option.wait(for: \.isHittable, toEqual: true, timeout: 10))
		option.tap()
		let named = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", project), object: projectMenu)
		XCTAssertEqual(XCTWaiter.wait(for: [named], timeout: 10), .completed)
	}

	/// Opens a tab once the tab bar takes a tap, and waits until it is the one shown.
	@MainActor func openTab(_ name: String) {
		let tab = tabBars.buttons[name]
		XCTAssertTrue(tab.wait(for: \.isHittable, toEqual: true, timeout: 5))
		tab.tap()
		XCTAssertTrue(tab.wait(for: \.isSelected, toEqual: true, timeout: 5))
	}
}
