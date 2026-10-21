import XCTest

extension XCUIApplication {
	/// Opens a project from the menu in the bar, and waits until the menu names it: until then the menu may still
	/// be closing, and a tap on the tab bar lands on nothing.
	@MainActor func openProject(_ project: String) {
		let projectMenu = buttons["project-menu"]
		let existing = collectionViews.allElementsBoundByAccessibilityElement.map(\.frame)
		let pageWidth = frame.width
		func openedMenus() -> [XCUIElement] {
			collectionViews.allElementsBoundByAccessibilityElement.filter {
				let bounds = $0.frame
				return bounds.width < pageWidth && !existing.contains(bounds)
			}
		}
		projectMenu.tap()
		let appeared = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in openedMenus().count == 1 }, object: nil)
		XCTAssertEqual(XCTWaiter.wait(for: [appeared], timeout: 10), .completed)
		// The popup adds a container; its bounds do not depend on which lazy rows currently exist.
		let menus = openedMenus()
		guard menus.count == 1, let menu = menus.first else {
			XCTFail("Expected one new project menu, found \(menus.count)")
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
