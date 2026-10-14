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
	/// Who may produce evidence for the case: human, auto, agent.
	public var methods: [String]
	/// Whether an automated test is wanted: none, wanted or not-applicable.
	public var automate: String
	/// Custom field values.
	public var fields: [String: String]

	public init(
		title: String, pre: String = "", steps: [Step] = [], methods: [String] = ["human"], automate: String = "none",
		fields: [String: String] = [:]
	) {
		self.title = title
		self.pre = pre
		self.steps = steps
		self.methods = methods
		self.automate = automate
		self.fields = fields
	}

	init(_ wire: Wire.CaseBody) {
		self.init(
			title: wire.title, pre: wire.pre, steps: wire.steps.map(Step.init), methods: wire.methods,
			automate: wire.automate, fields: wire.fields ?? [:]
		)
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
	/// Where a new case goes: its folder's path, its tags and the requirements it covers. An edit to a case
	/// that exists changes none of them.
	public let placement: Placement?

	public struct Placement: Equatable, Sendable {
		public let folder: String
		public let tags: [String]
		public let covers: [String]

		public init(folder: String, tags: [String], covers: [String]) {
			self.folder = folder
			self.tags = tags
			self.covers = covers
		}
	}

	public init(id: Int, caseRef: String?, before: CaseContent?, after: CaseContent, placement: Placement? = nil) {
		self.id = id
		self.caseRef = caseRef
		self.before = before
		self.after = after
		self.placement = placement
	}

	/// What the edit changes, part by part, in the order of the case as it would be.
	public var changes: [Change] {
		var changes: [Change] = []
		if before?.title != after.title { changes.append(.title(from: before?.title, to: after.title)) }
		if (before?.pre ?? "") != after.pre { changes.append(.pre(from: before?.pre ?? "", to: after.pre)) }
		// What is not a step is part of the case too. An edit that changes only these must not look like none.
		if let before {
			if before.methods != after.methods { changes.append(.methods(from: before.methods, to: after.methods)) }
			if before.automate != after.automate { changes.append(.automate(from: before.automate, to: after.automate)) }
			if before.fields != after.fields { changes.append(.fields(from: before.fields, to: after.fields)) }
		} else {
			// Everything of a new case is new, and all of it is said.
			if let placement { changes.append(.placed(placement)) }
			changes.append(.methods(from: [], to: after.methods))
			changes.append(.automate(from: "", to: after.automate))
			if !after.fields.isEmpty { changes.append(.fields(from: [:], to: after.fields)) }
		}
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
		case methods(from: [String], to: [String])
		case automate(from: String, to: String)
		case fields(from: [String: String], to: [String: String])
		/// Where a new case goes.
		case placed(Placement)
		case kept(Step)
		case added(Step)
		case removed(Step)
		case changed(from: Step, to: Step)
	}
}
