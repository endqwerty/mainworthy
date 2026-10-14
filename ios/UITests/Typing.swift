import XCTest

extension XCUIElement {
	/// Types into a field that may hold text already, such as the address the sign-in form offers: the text there
	/// is deleted first. A tap at the right end puts the cursor after the last character.
	@MainActor func replaceText(_ text: String) {
		coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
		let held = (value as? String) ?? ""
		if !held.isEmpty, held != placeholderValue {
			typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: held.count))
		}
		typeText(text)
	}
}
