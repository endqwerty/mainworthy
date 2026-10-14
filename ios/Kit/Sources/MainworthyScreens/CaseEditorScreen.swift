import Foundation
import MainworthyClient
import Observation

/// A draft on the document the person opened. It belongs to the screen, so backgrounding loses no typing.
@MainActor @Observable
public final class CaseEditorScreen {
	public let source: CaseSource
	public var content: CaseContent
	public var reason = ""
	public private(set) var busy = false
	public private(set) var notice: String?
	public private(set) var settled = false
	private let original: CaseContent
	private var used: Set<String>
	private let project: ProjectClient
	/// A request whose reply was lost stays unchanged. Editing is paused until it has a reply.
	private var sent: SuiteSubmission?

	package init(project: ProjectClient, source: CaseSource, used: Set<String> = []) {
		self.project = project
		self.source = source
		let body: CaseContent = if case .edit(let document) = source { document.content } else { CaseContent(title: "") }
		content = body
		original = body
		self.used = used.union(body.steps.map(\.id))
	}

	public var dirty: Bool { content != original || !reason.isEmpty }
	public var locked: Bool { busy || sent != nil || settled }
	public var maySave: Bool {
		!busy && !settled && (sent != nil || (!content.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
			&& content.steps.allSatisfy { !$0.action.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }))
	}
	public var isRetrying: Bool { sent != nil && !busy }

	public func addStep() {
		guard !locked else { return }
		do {
			let id = try newStepId(taken: used)
			used.insert(id)
			content.steps.append(Step(id: id, action: "", expected: nil))
		} catch { notice = error.shown }
	}

	public func removeSteps(at offsets: IndexSet) {
		guard !locked else { return }
		for index in offsets.sorted(by: >) where content.steps.indices.contains(index) { content.steps.remove(at: index) }
	}

	public func moveSteps(from offsets: IndexSet, to destination: Int) {
		guard !locked else { return }
		let picked = content.steps.enumerated().filter { offsets.contains($0.offset) }.map(\.element)
		let rest = content.steps.enumerated().filter { !offsets.contains($0.offset) }.map(\.element)
		let target = min(max(destination - offsets.filter { $0 < destination }.count, 0), rest.count)
		content.steps = Array(rest.prefix(target)) + picked + Array(rest.dropFirst(target))
	}

	/// Returns an adopted version for the suite to open. Waiting and overlapping proposals stay on this page
	/// with the server's sentence, and cannot be sent a second time as another proposal.
	package func save() async -> SaveCaseOutcome? {
		guard maySave else { return nil }
		busy = true
		defer { busy = false }
		if sent == nil {
			var body = content
			body.title = body.title.trimmingCharacters(in: .whitespacesAndNewlines)
			body.pre = body.pre.trimmingCharacters(in: .whitespacesAndNewlines)
			body.steps = body.steps.map { step in
				let expected = step.expected?.trimmingCharacters(in: .whitespacesAndNewlines)
				return Step(id: step.id, action: step.action.trimmingCharacters(in: .whitespacesAndNewlines),
					expected: expected?.isEmpty == false ? expected : nil)
			}
			sent = SuiteSubmission(source: source, content: body, reason: reason)
		}
		guard let sent else { return nil }
		do {
			let outcome = try await project.saveCase(sent)
			self.sent = nil
			switch outcome {
			case .adopted: settled = true
			case .waiting(let question, let needs):
				settled = true
				notice = "The edit waits for a person's answer in the Queue\(question.map { " (\($0))" } ?? "")."
				if let needs { notice = "\(notice ?? "") The server asks for \(needs)." }
			case .overlap(let question, let paths, let sentence):
				settled = true
				notice = "The case changed meanwhile and the edits overlap: \(paths.joined(separator: ", ")). "
					+ "The proposal waits for its author in the web app\(question.map { " (\($0))" } ?? ""), "
					+ "where an overlap is resolved."
				if let sentence { notice = "\(notice ?? "") \(sentence)" }
			case .notTaken(let sentence): notice = sentence
			}
			return outcome
		} catch {
			// A refusal is definite. A lost or unreadable reply could have written: retry the same command.
			if case ClientError.refused = error { self.sent = nil }
			notice = error.shown
			return nil
		}
	}
}
