import Foundation
import MainworthyClient
import Observation

/// A draft on the document the person opened. It belongs to the screen, so backgrounding loses no typing.
@MainActor @Observable
public final class CaseEditorScreen {
	public private(set) var source: CaseSource
	public var content: CaseContent
	public var reason = ""
	public private(set) var busy = false
	public private(set) var notice: String?
	private struct WaitingProposal {
		let question: String
		let content: CaseContent
		let needs: String?
	}
	private enum SaveState {
		case editing
		case submitting(SuiteSubmission, adopted: CaseStamp?)
		case waiting(WaitingProposal)
		case settled
	}
	private var state = SaveState.editing
	public var settled: Bool { if case .settled = state { true } else { false } }
	public var isWaiting: Bool { if case .waiting = state { true } else { false } }
	public private(set) var savedDocument: CaseDocument?
	public private(set) var conflict: CaseConflict?
	public private(set) var conflictClosed = false
	private var overlapQuestion: String?
	private var mergeSent: MergeSubmission?
	private var original: CaseContent
	private var used: Set<String>
	private let project: ProjectClient
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
	public var locked: Bool {
		if case .editing = state { return busy || conflict != nil || overlapQuestion != nil }
		return true
	}
	/// Lengths use UTF-16, as the server's JavaScript strings do. Other text and step counts have no cap.
	public var validation: [String] {
		var issues: [String] = []
		if case .edit(let opened) = source, opened.hasSharedSteps {
			issues.append("Edit fragments and their pins in the web editor.")
		}
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
	public var maySave: Bool {
		guard !busy, !settled, !conflictClosed else { return false }
		if mergeSent != nil { return true }
		if let conflict {
			return conflict.complete && reason.utf16.count <= 500 && (!conflict.wantsReason || !trimmed(reason).isEmpty)
		}
		switch state {
		case .submitting, .waiting: return true
		case .editing: return validation.isEmpty
		case .settled: return false
		}
	}
	public var isRetrying: Bool {
		guard !busy else { return false }
		switch state {
		case .submitting, .waiting: return true
		case .editing: return mergeSent != nil || (overlapQuestion != nil && conflict == nil)
		case .settled: return false
		}
	}

	public func chooseConflict(_ address: ConflictAddress, side: CaseConflict.Side) {
		guard !busy, mergeSent == nil, !settled, !conflictClosed else { return }
		do { try conflict?.choose(address, side: side) } catch { notice = error.shown }
	}

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

	/// Waiting retries only read the recorded decision. An uncertain save keeps its original command.
	package func save() async -> SaveCaseOutcome? {
		guard maySave else { return nil }
		if isWaiting { await refreshWaiting(); return nil }
		busy = true
		defer { busy = false }
		if conflict != nil || overlapQuestion != nil || mergeSent != nil { return await resolveConflict() }
		if case .editing = state {
			state = .submitting(SuiteSubmission(source: source, content: content, reason: reason), adopted: nil)
		}
		guard case .submitting(let sent, let adopted) = state else { return nil }
		do {
			let outcome: SaveCaseOutcome
			if let adopted { outcome = .adopted(adopted) }
			else { outcome = try await project.saveCase(sent) }
			switch outcome {
			case .adopted(let stamp):
				guard let stamp else {
					state = .settled
					notice = "The server adopted the proposal without naming a saved version. Your draft is kept here."
					return .notTaken(notice ?? "Your draft is kept here.")
				}
				state = .submitting(sent, adopted: stamp)
				let document = try await project.caseDocument(stamp.ref, version: stamp.version)
				state = .settled
				guard matches(document, sent.content) else {
					notice = "The saved version differs from what you typed. Your draft is kept here. Read the case in the web app."
					return .notTaken(notice ?? "Your draft is kept here.")
				}
				savedDocument = document
			case .waiting(let question, let needs):
				guard let question else { throw ClientError.unreadable }
				let waiting = WaitingProposal(question: question, content: sent.content, needs: needs)
				state = .waiting(waiting)
				notice = waitingNotice(waiting)
			case .overlap(let question, _, _):
				guard let question, case .edit(let opened) = source else { throw ClientError.unreadable }
				overlapQuestion = question
				state = .editing
				conflict = try await project.conflict(question, ref: opened.ref)
				notice = "Both edits are kept. Choose each overlapping field, then record the merge."
			case .notTaken(let sentence):
				state = .editing
				notice = sentence
			}
			return outcome
		} catch {
			if case .submitting(_, let stamp) = state {
				if case ClientError.refused(let code, _) = error,
					code != "internal", sent.delivery.definitelyRejected, stamp == nil { state = .editing }
				else { sent.delivery.uncertain() }
			}
			let why = error.shown
			let stop = why.last.map { ".!?".contains($0) } == true ? "" : "."
			if case .submitting(_, nil) = state { notice = "\(why)\(stop) Retry will send the same save." }
			else { notice = why }
			return nil
		}
	}

	package func refreshWaiting() async {
		guard !busy, case .waiting(let waiting) = state else { return }
		busy = true
		defer { busy = false }
		do {
			switch try await project.caseProposal(waiting.question) {
			case .waiting: notice = waitingNotice(waiting)
			case .rejected:
				state = .editing
				notice = "The proposal was rejected. Your draft is kept here."
			case .adopted(let stamp):
				let document = try await project.caseDocument(stamp.ref, version: stamp.version, includingCustomFields: true)
				let ids = try await project.usedStepIds(of: document)
				let differs = document.content != waiting.content
				source = .edit(document)
				content = document.content
				original = document.content
				used.formUnion(ids)
				reason = ""
				state = .editing
				notice = "Proposal accepted. Continue editing \(stamp.ref), version \(stamp.version)."
				if differs { notice? += " The saved case includes changes you did not make. Read it before editing again." }
			}
		} catch {
			notice = "Still waiting to read the proposal's outcome. \(error.shown) Your draft is kept here. Retry to check again."
		}
	}

	private func matches(_ document: CaseDocument, _ submitted: CaseContent) -> Bool {
		document.content.title == submitted.title && document.content.pre == submitted.pre && document.content.steps == submitted.steps
	}

	private func waitingNotice(_ waiting: WaitingProposal) -> String {
		let sentence = "The edit waits for a person's answer in the Queue (\(waiting.question))."
		return sentence + (waiting.needs.map { " The server asks for \($0)." } ?? "")
	}

	private func resolveConflict() async -> SaveCaseOutcome? {
		do {
			if conflict == nil, let question = overlapQuestion, case .edit(let opened) = source {
				conflict = try await project.conflict(question, ref: opened.ref)
				notice = "Both edits are kept. Choose each overlapping field, then record the merge."
				return nil
			}
			guard let conflict else { throw ClientError.unreadable }
			let recovering = mergeSent != nil
			if mergeSent == nil { mergeSent = MergeSubmission(conflict, reason: reason) }
			guard let submission = mergeSent else { return nil }
			let outcome = try await project.resolve(submission, recovering: recovering)
			switch outcome {
			case .adopted(let stamp):
				let document = try await project.caseDocument(stamp.ref, version: stamp.version)
				savedDocument = document
				state = .settled; mergeSent = nil
				return .adopted(stamp)
			case .unchanged:
				state = .settled; mergeSent = nil
				notice = "Conflict resolved. The recorded version already holds this text."
			case .waiting(let question):
				state = .settled; mergeSent = nil
				notice = "Your merge is proposed and waits for a person's answer in the Queue (\(question))."
			case .moved(let question):
				// Do not drop the pending command until its replacement has been read. A failed read recovers
				// the same reply and keeps every choice from this card.
				let next = try await project.conflict(question, ref: conflict.ref)
				self.conflict = next; overlapQuestion = question; mergeSent = nil
				notice = "Nothing was adopted. The case changed again. Your merge is kept in this new conflict."
			case .closed(let sentence):
				mergeSent = nil; conflictClosed = true
				notice = sentence
			case .refused(let sentence):
				mergeSent = nil
				notice = sentence
			}
		} catch { notice = error.shown }
		return nil
	}

}
