import Foundation

/// One step of a case.
public struct Step: Identifiable, Equatable, Sendable {
	/// Short, unique within its case and never used again, so a result or an edit can name the step.
	public let id: String
	public var action: String
	/// What must be true afterwards. Nil when the author has not said.
	public var expected: String?

	public init(id: String, action: String, expected: String?) {
		self.id = id
		self.action = action
		self.expected = expected
	}

	init(_ wire: Wire.Step) {
		self.init(id: wire.id, action: wire.action, expected: wire.expected)
	}
}

/// The content of a case that has versions: what it is called, what must hold before, and its steps.
public struct CaseContent: Equatable, Sendable {
	public var title: String
	/// Preconditions. Empty when there are none.
	public var pre: String
	public var steps: [Step]

	public init(title: String, pre: String = "", steps: [Step] = []) {
		self.title = title
		self.pre = pre
		self.steps = steps
	}

	init(_ wire: Wire.CaseBody) {
		self.init(title: wire.title, pre: wire.pre, steps: wire.steps.map(Step.init))
	}
}

/// One case of a proposed edit: what it is now and what it would be.
public struct EditedCase: Identifiable, Equatable, Sendable {
	public let id: Int
	/// The case, or nil for one the edit creates.
	public let caseRef: String?
	/// The case as it is. Nil for a new case.
	public let before: CaseContent?
	public let after: CaseContent

	/// What the edit changes, part by part, in the order of the case as it would be.
	public var changes: [Change] {
		var changes: [Change] = []
		if before?.title != after.title { changes.append(.title(from: before?.title, to: after.title)) }
		if (before?.pre ?? "") != after.pre { changes.append(.pre(from: before?.pre ?? "", to: after.pre)) }
		// A step keeps its id for good, so two versions are set side by side by id and nothing is guessed.
		let old = before?.steps ?? []
		let kept = Set(after.steps.map(\.id))
		var passed = 0
		for step in after.steps {
			if let at = old.firstIndex(where: { $0.id == step.id }) {
				// The steps that stood before this one and are gone, where they stood.
				for gone in old[passed..<max(passed, at)] where !kept.contains(gone.id) { changes.append(.removed(gone)) }
				passed = max(passed, at + 1)
				changes.append(old[at] == step ? .kept(step) : .changed(from: old[at], to: step))
			} else {
				changes.append(.added(step))
			}
		}
		for gone in old[passed...] where !kept.contains(gone.id) { changes.append(.removed(gone)) }
		return changes
	}

	public enum Change: Equatable, Sendable {
		case title(from: String?, to: String)
		case pre(from: String, to: String)
		case kept(Step)
		case added(Step)
		case removed(Step)
		case changed(from: Step, to: Step)
	}
}
