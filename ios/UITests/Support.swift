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
	/// Scrolls toward controls below the current viewport, stopping when the list no longer moves.
	@MainActor func scrollUpTo(_ target: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
		var previous: (label: String, frame: CGRect)?
		var unchanged = 0
		var swipes = 0
		while swipes < 100 && !(target.exists && target.isHittable) {
			guard let last = buttons.allElementsBoundByAccessibilityElement.last else { break }
			let position = (label: last.label, frame: last.frame)
			if let previous, previous.label == position.label,
				abs(previous.frame.minY - position.frame.minY) < 1,
				abs(previous.frame.maxY - position.frame.maxY) < 1 {
				unchanged += 1
			} else { unchanged = 0 }
			if unchanged == 2 { break }
			previous = position
			swipeUp()
			swipes += 1
		}
		XCTAssertTrue(target.exists && target.isHittable, "After \(swipes) upward swipes: \(target.debugDescription)", file: file, line: line)
	}
}
