import Foundation
import MainworthyClient
import Observation

/// The queue of one project: the questions that wait, or the ones that are decided, and answering them.
///
/// The server is the record. An answer is sent, and the list is read again when the reply comes: nothing is
/// shown as decided that the server has not said is decided.
@MainActor @Observable
public final class QueueScreen: ProjectScreen {
	public enum Showing: Hashable, Sendable {
		case open, decided
	}

	public enum Loading: Equatable, Sendable {
		/// Nothing was read yet.
		case first
		case done
		/// The first read failed: the sentence. A later read that fails leaves what is shown and says so in `notice`.
		case failed(String)
	}

	/// What the screen says about the last thing that happened, under the list.
	public struct Notice: Equatable, Sendable {
		public let text: String
		public let isProblem: Bool
		/// The question whose answer "Undo" withdraws, when there is one to withdraw.
		public let undoes: Question?
		/// The questions one answer to a selection decided, which "Undo" withdraws together.
		public var undoesAll: [Question] = []
	}

	/// What a proposed edit changes, as far as it was read.
	public enum Documents: Equatable, Sendable {
		case reading
		case read([EditedCase])
		case failed(String)
	}

	public private(set) var showing = Showing.open
	public private(set) var filter: Kind?
	public private(set) var questions: [Question] = []
	public private(set) var counts = QueueCounts()
	public private(set) var loading = Loading.first
	public private(set) var hasMore = false
	public private(set) var notice: Notice?
	/// What was typed for an answer, by the question: where a defect is tracked, and the reason. It is kept
	/// until an answer to that question is taken, so a sheet that closed on a refusal opens with it again.
	public struct Typed: Equatable, Sendable {
		public var reference = ""
		public var reason = ""

		public init() {}
	}

	public var typed: [String: Typed] = [:]
	private var mappings: [String: MappingScreen] = [:]

	/// The most questions one selection holds: what one saved answer, sent as one request, carries (decision 0088).
	public static let selectionLimit = decideMax
	/// The key under which the reference and reason of an answer to the selection are kept in `typed`.
	public static let selectionTyping = "selection"
	/// Whether the list selects questions instead of opening them.
	public private(set) var isSelecting = false
	/// The questions selected to take one answer together, in the order they were selected.
	public private(set) var selected: [String] = []

	public func beginMapping(_ question: Question, creating: Bool) {
		mapping(question, creating: creating).reopen(question)
	}

	public func mapping(_ question: Question, creating: Bool) -> MappingScreen {
		let key = "\(question.ref) \(creating)"
		if let kept = mappings[key] { return kept }
		let draft = MappingScreen(project: project, question: question, creating: creating)
		mappings[key] = draft
		return draft
	}

	/// What each proposed edit changes, by its question and that question's evidence, once it was opened.
	private var documents: [String: Documents] = [:]
	/// The questions with an answer or a withdrawal on its way. A second one is not sent meanwhile.
	public private(set) var busy: Set<String> = []

	/// The question whose page is open, and that question as it was read by itself when the list did not hold
	/// it: it is further down than the list was read, it is of the other list (open, decided), or it was
	/// opened from another screen.
	private var opened: (ref: String, alone: Question?)?
	/// Counts the reads of the opened question, so that one which was overtaken does not replace a newer one.
	private var openedReads = 0
	/// Whether the open question is being read by itself for the first time: its page has nothing to show yet.
	public private(set) var isOpening = false
	public let outbox: AnswerOutbox
	private let project: ProjectClient
	private var next: String?
	/// Counts every read that was started, so that a slow one that was overtaken does not replace a newer one.
	private var reads = 0

	package init(project: ProjectClient, outbox: AnswerOutbox? = nil) {
		self.project = project
		self.outbox = outbox ?? AnswerOutbox(project: project)
	}

	/// The question as it is now: as the list holds it, or, for the one whose page is open, as it was read by
	/// itself where the list does not hold it. A page shows its question whatever the list shows: one that was
	/// opened from another screen while this list shows the decided ones, one further down than the list was
	/// read, one that was answered a moment ago and is now decided. Nil for a question the project does not
	/// have, or has no more.
	public func current(_ ref: String) -> Question? {
		questions.first { $0.ref == ref } ?? (opened?.ref == ref ? opened?.alone : nil)
	}

	/// Says which question's page is open, and reads that question where the list does not hold it.
	public func open(_ ref: String) async {
		if opened?.ref != ref { opened = (ref, nil) }
		isOpening = current(ref) == nil
		await readOpened()
		isOpening = false
	}

	/// The page was left.
	public func close(_ ref: String) {
		if opened?.ref == ref { opened = nil }
	}

	private func readOpened() async {
		guard let ref = opened?.ref else { return }
		guard !questions.contains(where: { $0.ref == ref }) else {
			opened = (ref, nil)
			return
		}
		openedReads += 1
		let mine = openedReads
		guard let read = try? await project.question(ref), opened?.ref == ref, mine == openedReads else { return }
		opened = (ref, read)
	}

	/// Reads the list, the first time and whenever the person changes what it shows.
	public func show(_ showing: Showing, filter: Kind?) async {
		guard showing != self.showing || filter != self.filter || loading != .done else { return }
		if showing != self.showing || filter != self.filter { selected = [] }
		if showing != .open { isSelecting = false }
		self.showing = showing
		self.filter = filter
		questions = []
		loading = .first
		await read()
	}

	/// Reads the list again and keeps what is shown until the reply is there.
	public func refresh() async {
		await outbox.send()
		for entry in outbox.entries {
			for member in entry.members where member.outcome?.isDecided == true { typed[member.question] = nil }
		}
		await read()
	}

	/// Reads the next page, when the list was scrolled to its end.
	public func more() async {
		guard hasMore, let cursor = next else { return }
		reads += 1
		let mine = reads
		guard let page = try? await project.questions(open: showing == .open, kind: filter, after: cursor),
			mine == reads
		else { return }
		let known = Set(questions.map(\.ref))
		questions += page.questions.filter { !known.contains($0.ref) }
		counts = page.counts
		next = page.next
		hasMore = page.next != nil
	}

	private func read() async {
		reads += 1
		let mine = reads
		do {
			// As far down as the list was read before, so that a question further down than the first page,
			// which may be the one that is open, stays in it.
			let wanted = questions.count
			var page = try await project.questions(open: showing == .open, kind: filter)
			var read = page.questions
			while let cursor = page.next, read.count < wanted {
				page = try await project.questions(open: showing == .open, kind: filter, after: cursor)
				read += page.questions
			}
			guard mine == reads else { return }
			questions = read
			counts = page.counts
			next = page.next
			hasMore = page.next != nil
			loading = .done
			dropUnlisted()
			await readOpened()
		} catch is CancellationError {
		} catch {
			guard mine == reads else { return }
			if loading == .done {
				notice = Notice(text: error.shown, isProblem: true, undoes: nil)
			} else {
				loading = .failed(error.shown)
			}
		}
	}

	/// Answers a question. Returns whether the answer settled it, so the view can leave the question.
	@discardableResult
	public func answer(
		_ question: Question, with choice: Choice, reference: String = "", reason: String = ""
	) async -> Bool {
		// A question that is decided is not answered over from here, also when the copy the person acted on
		// was read while it was open: the server would take the answer in place of the one that stands.
		guard question.isOpen, current(question.ref)?.isOpen != false else {
			notice = Notice(
				text: "Nothing was recorded for \(question.ref): it was decided meanwhile. Read it again.", isProblem: true,
				undoes: nil
			)
			return false
		}
		guard isShown(question) else {
			notice = Notice(
				text: "Nothing was recorded for \(question.ref): what it asks about has not been shown yet.",
				isProblem: true, undoes: nil
			)
			return false
		}
		guard !hasPendingAnswer(question.ref) else { return false }
		guard busy.insert(question.ref).inserted else { return false }
		defer { busy.remove(question.ref) }
		do {
			let saved = try await outbox.record([question], with: choice, reference: reference, reason: reason)
			guard let outcome = saved.outcomes?[question.ref] else {
				let state = outbox.sending ? "sending" : "saved on this device, waiting to send"
				notice = Notice(
					text: "\(question.ref): \(state). Open Unsent answers to see its outcome.",
					isProblem: false, undoes: nil
				)
				return false
			}
			switch outcome {
			case .decided(let decision):
				typed[question.ref] = nil
				// An accepted edit cannot be withdrawn: the case's history is where it is undone.
				var undoable = question
				undoable.ifDecision = decision
				notice = Notice(text: "\(question.ref): \(choice.label).", isProblem: false, undoes: question.kind == .adopt ? nil : undoable)
			case .advised(let who):
				notice = Notice(text: "\(question.ref): recorded as advice. Waiting for \(who).", isProblem: false, undoes: nil)
			case .overtaken(let why):
				notice = Notice(
					text: "Nothing was recorded for \(question.ref): \(why). Read the question again and answer on its current evidence.", isProblem: true, undoes: nil
				)
			case .notTaken(let asks):
				notice = Notice(
					text: "Nothing was recorded for \(question.ref). The server asks for \(asks).", isProblem: true,
					undoes: nil
				)
			}
			await read()
			return outcome.isDecided
		} catch {
			notice = Notice(text: error.shown, isProblem: true, undoes: nil)
			return false
		}
	}

	public func hasPendingAnswer(_ ref: String) -> Bool {
		outbox.entries.contains { $0.waiting && $0.questions.contains(ref) }
	}

	/// Withdraws the decision on a question: the answer just given ("Undo"), or one in the decided list.
	/// Withdraws a question's decision. Returns whether it was withdrawn, so the view leaves the question only
	/// then: a refusal is shown where the person pressed.
	@discardableResult
	public func withdraw(_ question: Question, reason: String = "") async -> Bool {
		guard busy.insert(question.ref).inserted else { return false }
		defer { busy.remove(question.ref) }
		do {
			let withdrawn: Bool
			switch try await project.withdraw(question, reason: reason) {
			case .withdrawn(let note):
				typed[QueueScreen.withdrawing(question.ref)] = nil
				notice = Notice(
					text: "\(question.ref): the decision is withdrawn\(note.map { " (\($0))" } ?? "").", isProblem: false,
					undoes: nil
				)
				withdrawn = true
			case .notTaken(let asks):
				notice = Notice(
					text: "Withdrawal of \(question.ref) was not confirmed. Server response: \(asks).", isProblem: true,
					undoes: nil
				)
				withdrawn = false
			}
			await read()
			return withdrawn
		} catch {
			notice = Notice(text: error.shown, isProblem: true, undoes: nil)
			return false
		}
	}

	// MARK: Several questions, one answer (decision 0088)

	/// The selected questions as the list holds them now.
	public var selection: [Question] {
		selected.compactMap { ref in questions.first { $0.ref == ref } }
	}

	/// Starts selecting, or stops and forgets the selection.
	public func select(_ on: Bool) {
		guard on != isSelecting else { return }
		isSelecting = on && showing == .open
		selected = []
	}

	/// Why this question cannot join the selection, or nil when it can. One answer is for one kind, and nobody
	/// selects what they cannot settle or what has to be read on its own page before an answer counts.
	public func whyNotSelectable(_ question: Question) -> String? {
		let ref = question.ref
		guard showing == .open, question.isOpen else { return "\(ref) is decided." }
		if question.standing == .forbidden { return "You cannot settle \(ref)." }
		if hasPendingAnswer(ref) { return "\(ref) has an answer waiting to send." }
		switch question.evidence {
		case .unreadable: return "\(ref) is answered in the web app: this build cannot show what it asks about."
		case .proposal: return "\(ref) is answered on its own: its edits are read on its page before an answer counts."
		case .finding(let finding) where finding.suggestion != nil:
			return "\(ref) is answered on its own: its suggested edit is read on its page before an answer counts."
		default: break
		}
		if let kind = selection.first?.kind, kind != question.kind {
			return "\(ref) is \(question.kind == .map ? "unlinked" : "a \(question.kind.name)") and the selection is of \(kind.many): one answer is for one kind."
		}
		return nil
	}

	/// Adds a question to the selection or takes it out. A question that cannot join says why.
	public func toggle(_ question: Question) {
		if let index = selected.firstIndex(of: question.ref) {
			selected.remove(at: index)
			return
		}
		if let why = whyNotSelectable(question) {
			notice = Notice(text: why, isProblem: true, undoes: nil)
			return
		}
		guard selected.count < QueueScreen.selectionLimit else {
			notice = Notice(
				text: "A selection holds at most \(QueueScreen.selectionLimit) questions. Answer these first.",
				isProblem: true, undoes: nil
			)
			return
		}
		selected.append(question.ref)
	}

	/// The listed questions that "Select all" would select: of the selection's kind, or of the one kind the list
	/// is filtered by, as many as a selection holds.
	public var selectable: [Question] {
		guard let kind = selection.first?.kind ?? filter else { return [] }
		let chosen = Set(selected)
		let more = questions.filter { $0.kind == kind && !chosen.contains($0.ref) && whyNotSelectable($0) == nil }
		return selection + more.prefix(max(0, QueueScreen.selectionLimit - selected.count))
	}

	public func selectAll() {
		selected = selectable.map(\.ref)
	}

	public func clearSelection() {
		selected = []
	}

	/// The answers every selected question takes, in the order the first shows them.
	public var sharedChoices: [Choice] { QueueScreen.sharedChoices(of: selection) }

	/// The answers every one of these questions takes. Linking a test asks for a case for each test, so it is given
	/// to one question at a time on its page.
	public static func sharedChoices(of questions: [Question]) -> [Choice] {
		guard let first = questions.first else { return [] }
		return first.choices.filter { choice in
			(choice.takes == .nothing || choice.takes == .reference)
				&& questions.allSatisfy { question in question.choices.contains { $0.answer == choice.answer } }
		}
	}

	/// Gives one answer to these selected questions, as they were shown when the person chose it: one saved answer,
	/// sent as one request on the evidence the person saw. A question whose evidence changed since is refused by
	/// the server, never answered on its new evidence, and each question gets its own decision and its own
	/// outcome. Returns whether any of them was decided.
	@discardableResult
	public func answerAll(
		_ chosen: [Question], with choice: Choice, reference: String = "", reason: String = ""
	) async -> Bool {
		guard !chosen.isEmpty, chosen.allSatisfy({ selected.contains($0.ref) }) else {
			notice = Notice(text: "Nothing was recorded: the selection changed. Select the questions again.", isProblem: true, undoes: nil)
			return false
		}
		for question in chosen {
			if let why = whyNotSelectable(question) {
				notice = Notice(text: "Nothing was recorded. \(why)", isProblem: true, undoes: nil)
				return false
			}
		}
		guard QueueScreen.sharedChoices(of: chosen).contains(where: { $0.answer == choice.answer }) else {
			notice = Notice(text: "Nothing was recorded: not every selected question takes this answer.", isProblem: true, undoes: nil)
			return false
		}
		if chosen.contains(where: \.wantsReason), reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			notice = Notice(text: "Nothing was recorded: the policy asks for a reason.", isProblem: true, undoes: nil)
			return false
		}
		let refs = Set(chosen.map(\.ref))
		guard busy.isDisjoint(with: refs) else { return false }
		busy.formUnion(refs)
		defer { busy.subtract(refs) }
		let saved: AnswerOutbox.Entry
		do {
			saved = try await outbox.record(chosen, with: choice, reference: reference, reason: reason)
		} catch {
			notice = Notice(text: "Nothing was recorded. \(error.shown)", isProblem: true, undoes: nil)
			return false
		}
		selected = []
		guard let outcomes = saved.outcomes else {
			// The whole answer waits on the device: nothing is claimed of any question.
			let state = outbox.sending ? "sending" : "saved on this device, waiting to send"
			notice = Notice(
				text: "\(chosen.counted): \(state). Open Unsent answers to see the outcome.",
				isProblem: false, undoes: nil
			)
			return false
		}
		var decided: [Question] = []
		var refused: [String] = []
		var advised = 0
		for question in chosen {
			switch outcomes[question.ref] {
			case .decided(let decision)?:
				typed[question.ref] = nil
				var undoable = question
				undoable.ifDecision = decision
				decided.append(undoable)
			case .advised?: advised += 1
			case .overtaken(let why)?: refused.append("\(question.ref): \(why)")
			case .notTaken(let why)?: refused.append("\(question.ref): the server asks for \(why)")
			case nil: refused.append("\(question.ref): no reply")
			}
		}
		if refused.isEmpty { typed[QueueScreen.selectionTyping] = nil }
		var parts: [String] = []
		if !decided.isEmpty { parts.append("\(decided.counted): \(choice.label).") }
		if advised > 0 { parts.append("\(advised) recorded as advice.") }
		if !refused.isEmpty {
			parts.append("Not recorded, read \(refused.count == 1 ? "it" : "them") again: \(refused.joined(separator: "; ")).")
		}
		await read()
		notice = Notice(text: parts.joined(separator: " "), isProblem: !refused.isEmpty, undoes: nil, undoesAll: decided)
		return !decided.isEmpty
	}

	/// Withdraws every decision one answer to a selection made. Returns whether all of them were withdrawn.
	@discardableResult
	public func withdrawAll(_ questions: [Question], reason: String = "") async -> Bool {
		let refs = Set(questions.map(\.ref))
		guard !questions.isEmpty, busy.isDisjoint(with: refs) else { return false }
		busy.formUnion(refs)
		defer { busy.subtract(refs) }
		var withdrawn = 0
		var kept: [String] = []
		do {
			let outcomes = try await project.withdraw(questions, reason: reason)
			for question in questions {
				switch outcomes[question.ref] {
				case .withdrawn: withdrawn += 1
				case .notTaken(let asks): kept.append("\(question.ref): \(asks)")
				case nil: kept.append("\(question.ref): the server did not confirm the withdrawal")
				}
			}
		} catch {
			kept = questions.map { "\($0.ref): \(error.shown)" }
		}
		if kept.isEmpty { typed[QueueScreen.withdrawing(QueueScreen.selectionTyping)] = nil }
		let done = withdrawn == 1 ? "1 decision is withdrawn." : "\(withdrawn) decisions are withdrawn."
		notice = Notice(
			text: kept.isEmpty ? done : "\(done) Not confirmed: \(kept.joined(separator: "; ")).",
			isProblem: !kept.isEmpty, undoes: nil
		)
		await read()
		return kept.isEmpty
	}

	/// Takes out of the selection what the list no longer holds open, and says so.
	private func dropUnlisted() {
		let open = Set(questions.filter { $0.isOpen && !hasPendingAnswer($0.ref) }.map(\.ref))
		let gone = selected.filter { !open.contains($0) }
		guard !gone.isEmpty else { return }
		selected.removeAll { gone.contains($0) }
		if !isSelecting { return }
		notice = Notice(
			text: "\(gone.joined(separator: ", ")) left the selection: \(gone.count == 1 ? "it is" : "they are") no longer open here.",
			isProblem: false, undoes: nil
		)
	}

	/// The key under which the reason for withdrawing a question's decision is kept in `typed`.
	public static func withdrawing(_ ref: String) -> String {
		"withdraw \(ref)"
	}

	public func dismissNotice() {
		notice = nil
	}

	/// Whether the person was shown what the question asks about, which is what lets them answer it. Evidence
	/// this build cannot read was not shown, and neither was an edit whose documents have not been read.
	public func isShown(_ question: Question) -> Bool {
		switch question.evidence {
		case .unreadable: false
		case .proposal(let edit): if case .read = documents(of: question) { edit.isShownWhole } else { false }
		case .failure, .unlinked, .finding, .signoff: true
		}
	}

	/// What the edit a question asks about changes, as far as it was read for the evidence the question has
	/// now, open or decided. An edit whose case changed since is another piece of evidence, and is read again.
	public func documents(of question: Question) -> Documents? {
		documents[QueueScreen.key(question)]
	}

	/// Reads what a proposed edit changes, when a question about it is opened and when the person asks again.
	public func readDocuments(of question: Question) async {
		guard case .proposal(let edit) = question.evidence else { return }
		let key = QueueScreen.key(question)
		if case .read = documents[key] { return }
		documents[key] = .reading
		do {
			documents[key] = .read(try await project.documents(of: edit))
		} catch is CancellationError {
			// The view that asked went away. What another read of the same documents brought stays.
			if case .reading = documents[key] { documents[key] = nil }
		} catch {
			if case .read = documents[key] { return }
			documents[key] = .failed(error.shown)
		}
	}

	/// What the documents were read for. Deciding a question keeps its evidence, but a decided proposal reads as it
	/// was proposed, and one that waits as what accepting does now, so the two are read apart.
	private static func key(_ question: Question) -> String {
		"\(question.ref) \(question.evidenceHash) \(question.isOpen ? "open" : "decided")"
	}
}
