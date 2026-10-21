import XCTest

extension XCUIApplication {
	/// Opens a project from the menu in the bar, and waits until the menu names it: until then the menu may still
	/// be closing, and a tap on the tab bar lands on nothing.
	@MainActor func openProject(_ project: String) {
		let projectMenu = buttons["project-menu"]
		let selected = projectMenu.label
		projectMenu.tap()
		let menus = collectionViews.containing(.button, identifier: selected)
		XCTAssertTrue(menus.firstMatch.waitForExistence(timeout: 10))
		// Bind the container before scrolling can remove its selected row from the lazy snapshot.
		guard let menu = collectionViews.allElementsBoundByAccessibilityElement.first(where: { $0.buttons[selected].exists }) else {
			XCTFail("The project menu did not open")
			return
		}
		let option = menu.buttons[project]
		menu.scrollUpTo(option)
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

extension XCUIElement {
	@MainActor func scrollUpTo(_ target: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
		let deadline = ContinuousClock.now.advanced(by: .seconds(30))
		while !target.isHittable && ContinuousClock.now < deadline {
			swipeUp()
		}
		XCTAssertTrue(target.isHittable, target.debugDescription, file: file, line: line)
	}
}
