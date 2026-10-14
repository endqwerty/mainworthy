import MainworthyScreens
import SwiftUI

extension QueueScreen {
	/// What is typed for an answer, or a withdrawal, to one question, as the bindings a sheet's fields take. The
	/// text lives in the screen's class (`typed`), where an answer the server refuses finds it again.
	func typing(_ key: String) -> (reference: Binding<String>, reason: Binding<String>) {
		(
			Binding(get: { self.typed[key]?.reference ?? "" }, set: { self.typed[key, default: Typed()].reference = $0 }),
			Binding(get: { self.typed[key]?.reason ?? "" }, set: { self.typed[key, default: Typed()].reason = $0 })
		)
	}
}
