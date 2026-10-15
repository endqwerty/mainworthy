import Foundation
import MainworthyClient
import Observation

/// A map answer kept with its question, including when its sheet or the session closes.
@MainActor @Observable
public final class MappingScreen {
	public private(set) var question: Question
	public let creating: Bool
	public var reason = ""
	public var search = ""
	public private(set) var selections: [String: SuiteCase] = [:]
	public private(set) var cases: [SuiteCase] = []
	public private(set) var hasMore = false
	public private(set) var searching = false
	public private(set) var searchNotice: String?
	public private(set) var notice: String?
	public private(set) var actual: Question?
	public private(set) var busy = false
	public private(set) var settled = false
	private let project: ProjectClient
	private var sent: MappingSubmission?
	private var decisionReceipt: Int?
	private var cursor: String?
	private var searched = ""
	private var reads = 0

	package init(project: ProjectClient, question: Question, creating: Bool) {
		self.project = project
		self.question = question
		self.creating = creating
	}

	public var tests: [TestRef] {
		if case .unlinked(let evidence) = question.evidence { evidence.tests } else { [] }
	}
	public var locked: Bool { busy || sent != nil || settled }
	public var isRetrying: Bool { sent != nil && !busy }
	public var mayReview: Bool { !busy && sent == nil }
	public func isCurrent(_ latest: Question) -> Bool {
		latest.evidenceHash == question.evidenceHash
			&& (latest.isOpen || decisionReceipt != nil && latest.ifDecision == decisionReceipt)
	}
	public var maySubmit: Bool {
		guard !busy, !settled else { return false }
		if sent != nil { return true }
		if let actual, !isCurrent(actual) { return false }
		guard question.isOpen, question.standing != .forbidden,
			case .unlinked(let evidence) = question.evidence,
			!tests.isEmpty, tests.count == evidence.count, Set(tests.map(\.ref)).count == tests.count,
			!question.wantsReason || !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
		else { return false }
		return creating || tests.allSatisfy { selections[$0.ref] != nil }
	}

	public func choose(_ selected: SuiteCase, for test: TestRef) {
		guard !locked, tests.contains(test) else { return }
		selections[test.ref] = selected
	}

	/// Explicitly review changed evidence while retaining choices for tests that are still shown.
	public func review(_ latest: Question) {
		guard mayReview, latest.ref == question.ref else { return }
		question = latest
		actual = latest
		settled = false
		decisionReceipt = nil
		notice = nil
	}

	package func reopen(_ latest: Question) {
		if decisionReceipt != nil, latest.isOpen { review(latest) }
	}

	public func findCases(more: Bool = false) async {
		if more && (!hasMore || searching || search != searched) { return }
		reads += 1
		let mine = reads
		let text = search
		defer { if mine == reads { searching = false } }
		let after = more ? cursor : nil
		if !more { cases = []; hasMore = false; cursor = nil }
		searching = true
		searchNotice = nil
		do {
			let page = try await project.cases(text: text, after: after, limit: 40)
			guard mine == reads, text == search else { return }
			let known = Set(cases.map(\.ref))
			cases = more ? cases + page.items.filter { !known.contains($0.ref) } : page.items
			cursor = page.next
			hasMore = page.next != nil
			searched = text
		} catch {
			guard mine == reads, text == search else { return }
			searchNotice = error.shown
		}
	}

	@discardableResult
	public func submit() async -> Bool {
		guard maySubmit else { return false }
		busy = true
		defer { busy = false }
		do {
			if sent == nil {
				sent = try MappingSubmission(question: question, creating: creating, selections: selections, reason: reason)
			}
			guard let sent else { return false }
			let outcome = try await project.answerMapping(sent)
			self.sent = nil
			switch outcome {
			case .decided(let decision):
				decisionReceipt = decision
				settled = true
				notice = creating ? "Recorded: one new case per shown test, linked to that test." : "Recorded: the shown tests are linked to their selected cases."
			case .advised(let needs):
				settled = true
				notice = "Recorded as advice. Waiting for \(needs). Your choices are kept here."
			case .overtaken(let why): notice = "Nothing was recorded: \(why). Your choices are kept here."
			case .notTaken(let needs): notice = "Nothing was recorded. The server asks for \(needs). Your choices are kept here."
			}
			actual = try? await project.question(question.ref)
			return outcome.isDecided
		} catch {
			if case ClientError.refused = error { sent = nil }
			if sent != nil {
				notice = "Linking tests and creating cases need a connection. This answer is not saved in Unsent answers. " + error.shown + " Retry to learn the result of the same command. Your choices are kept here."
			} else {
				notice = error.shown + " Your choices are kept here."
			}
			return false
		}
	}
}
