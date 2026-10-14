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
	public private(set) var savedDocument: CaseDocument?
	private let original: CaseContent
	private var used: Set<String>
	private let project: ProjectClient
	/// A request whose reply was lost stays unchanged. Editing is paused until it has a reply.
	private var sent: SuiteSubmission?
	private var adopted: CaseStamp?
	private static let whitespace = #"[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]"#
	private func trimmed(_ text: String) -> String {
		text.replacingOccurrences(of: "^\(Self.whitespace)+|\(Self.whitespace)+$",
			with: "", options: .regularExpression)
	}

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
	/// Lengths use UTF-16, as the server's JavaScript strings do. Other text and step counts have no cap.
	public var validation: [String] {
		var issues: [String] = []
		if content.title.isEmpty { issues.append("Enter a title.") }
		if content.title.utf16.count > 300 { issues.append("Title: use at most 300 UTF-16 units.") }
		let title = trimmed(content.title)
			.replacingOccurrences(of: "\(Self.whitespace)+", with: " ", options: .regularExpression)
		if title != content.title {
			issues.append("Title: remove surrounding whitespace and use single spaces between words.")
		}
		if content.pre != trimmed(content.pre) {
			issues.append("Preconditions: remove surrounding whitespace.")
		}
		for (index, step) in content.steps.enumerated() {
			let action = trimmed(step.action)
			if action.isEmpty { issues.append("Step \(index + 1): enter an action.") }
			if action != step.action { issues.append("Step \(index + 1) action: remove surrounding whitespace.") }
			if let expected = step.expected,
				expected.isEmpty || expected != trimmed(expected) {
				issues.append("Step \(index + 1) expected result: remove surrounding whitespace or leave it empty.")
			}
		}
		if reason.utf16.count > 500 { issues.append("Reason: use at most 500 UTF-16 units.") }
		return issues
	}
	public var maySave: Bool { !busy && !settled && (sent != nil || validation.isEmpty) }
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
		if sent == nil { sent = SuiteSubmission(source: source, content: content, reason: reason) }
		guard let sent else { return nil }
		do {
			let outcome: SaveCaseOutcome
			if let adopted { outcome = .adopted(adopted) }
			else { outcome = try await project.saveCase(sent) }
			switch outcome {
			case .adopted(let stamp):
				guard let stamp else {
					self.sent = nil
					settled = true
					notice = "The server adopted the proposal without naming a saved version. Your draft is kept here."
					return .notTaken(notice ?? "Your draft is kept here.")
				}
				adopted = stamp
				let document = try await project.caseDocument(stamp.ref, version: stamp.version)
				settled = true
				self.sent = nil
				guard document.content.title == content.title, document.content.pre == content.pre,
					document.content.steps == content.steps else {
					notice = "The saved version differs from what you typed. Your draft is kept here. Read the case in the web app."
					return .notTaken(notice ?? "Your draft is kept here.")
				}
				savedDocument = document
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
			self.sent = nil
			return outcome
		} catch {
			// A refusal is definite. A lost or unreadable reply could have written: retry the same command.
			if case ClientError.refused = error, adopted == nil { self.sent = nil }
			notice = error.shown
			return nil
		}
	}
}
