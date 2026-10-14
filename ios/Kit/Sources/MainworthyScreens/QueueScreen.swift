import Foundation
import MainworthyClient
import Observation

/// The queue of one project: the questions that wait, or the ones that are decided, and answering them.
///
/// The server is the record. An answer is sent, and the list is read again when the reply comes: nothing is
/// shown as decided that the server has not said is decided.
@MainActor @Observable
public final class QueueScreen {
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

	public private(set) var showing = Showing.open
	public private(set) var filter: Kind?
	public private(set) var questions: [Question] = []
	public private(set) var counts = QueueCounts()
	public private(set) var loading = Loading.first
	public private(set) var hasMore = false
	public private(set) var notice: Notice?
	/// The questions with an answer or a withdrawal on its way. A second one is not sent meanwhile.
	public private(set) var busy: Set<String> = []

	private let project: ProjectClient
	private var next: String?
	/// Counts every read that was started, so that a slow one that was overtaken does not replace a newer one.
	private var reads = 0

	package init(project: ProjectClient) {
		self.project = project
	}

	/// The question as the list holds it now, or nil once it left the list: answered here or by somebody else,
	/// or dissolved because the failure went away.
	public func current(_ ref: String) -> Question? {
		questions.first { $0.ref == ref }
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
			let page = try await project.questions(open: showing == .open, kind: filter)
			guard mine == reads else { return }
			questions = page.questions
			counts = page.counts
			next = page.next
			hasMore = page.next != nil
			loading = .done
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

	/// The cases a proposed edit would change, for a question about one. Read when the question is opened.
	public func documents(of edit: ProposedEdit) async throws -> [EditedCase] {
		try await project.documents(of: edit.proposal)
	}
}
