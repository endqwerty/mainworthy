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
	/// What each proposed edit changes, by its question and that question's evidence, once it was opened.
	private var documents: [String: Documents] = [:]
	/// The questions with an answer or a withdrawal on its way. A second one is not sent meanwhile.
	public private(set) var busy: Set<String> = []

	/// The question whose page is open, and that question as it was read by itself when the list did not hold
	/// it: it is further down than the list was read, or it was opened from another screen.
	private var opened: (ref: String, alone: Question?)?
	/// Whether the open question is being read by itself for the first time: its page has nothing to show yet.
	public private(set) var isOpening = false
	private let project: ProjectClient
	private var next: String?
	/// Counts every read that was started, so that a slow one that was overtaken does not replace a newer one.
	private var reads = 0

	package init(project: ProjectClient) {
		self.project = project
	}

	/// The question as it is now, or nil once it is no longer what this list shows: an open question that was
	/// answered, here or by somebody else, or that dissolved because the failure went away. A question whose
	/// page is open is read by itself where the list does not hold it, so that a list which was read less far
	/// down, or which another question was added to, does not make an open question look answered.
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
		// Read alone, it is still this list's only while it is what the list shows: open, or decided.
		guard let read = try? await project.question(ref), opened?.ref == ref else { return }
		opened = (ref, read.isOpen == (showing == .open) ? read : nil)
	}

	/// Reads the list, the first time and whenever the person changes what it shows.
	public func show(_ showing: Showing, filter: Kind?) async {
		guard showing != self.showing || filter != self.filter || loading != .done else { return }
		self.showing = showing
		self.filter = filter
		questions = []
		loading = .first
		await read()
	}

	/// Reads the list again and keeps what is shown until the reply is there.
	public func refresh() async {
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
		guard isShown(question) else {
			notice = Notice(
				text: "Nothing was recorded for \(question.ref): what it asks about has not been shown yet.",
				isProblem: true, undoes: nil
			)
			return false
		}
		guard busy.insert(question.ref).inserted else { return false }
		defer { busy.remove(question.ref) }
		do {
			let outcome = try await project.answer(question, with: choice, reference: reference, reason: reason)
			switch outcome {
			case .decided:
				// An accepted edit cannot be withdrawn: the case's history is where it is undone.
				let undoable = question.kind == .adopt ? nil : question
				notice = Notice(text: "\(question.ref): \(choice.label).", isProblem: false, undoes: undoable)
			case .advised(let who):
				notice = Notice(text: "\(question.ref): recorded as advice. Waiting for \(who).", isProblem: false, undoes: nil)
			case .overtaken(let why):
				notice = Notice(
					text: "Nothing was recorded for \(question.ref): \(why).", isProblem: true, undoes: nil
				)
			case .notTaken(let asks):
				notice = Notice(
					text: "Nothing was recorded for \(question.ref). The server asks for \(asks).", isProblem: true,
					undoes: nil
				)
			}
			await read()
			return outcome == .decided
		} catch {
			notice = Notice(text: error.shown, isProblem: true, undoes: nil)
			return false
		}
	}

	/// Withdraws the decision on a question: the answer just given ("Undo"), or one in the decided list.
	public func withdraw(_ question: Question, reason: String = "") async {
		guard busy.insert(question.ref).inserted else { return }
		defer { busy.remove(question.ref) }
		do {
			switch try await project.withdraw(question, reason: reason) {
			case .withdrawn(let note):
				notice = Notice(
					text: "\(question.ref): the decision is withdrawn\(note.map { " (\($0))" } ?? "").", isProblem: false,
					undoes: nil
				)
			case .notTaken(let asks):
				notice = Notice(
					text: "The decision on \(question.ref) stands. The server asks for \(asks).", isProblem: true,
					undoes: nil
				)
			}
			await read()
		} catch {
			notice = Notice(text: error.shown, isProblem: true, undoes: nil)
		}
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
	/// now. An edit whose case changed since is another piece of evidence, and is read again.
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

	private static func key(_ question: Question) -> String {
		"\(question.ref) \(question.evidenceHash)"
	}
}
