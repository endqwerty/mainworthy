import Foundation
import MainworthyClient
import Observation

/// Whether this query has been read. A new query can be replaced while its first reply is pending.
public enum ListLoading: Equatable, Sendable {
	/// The initial list has not been read yet.
	case first
	/// A new query is being read; search and filter controls remain available.
	case reading
	case done
	/// This query has no completed read to show.
	case failed(String)
}

/// A page of a list the server reads a hundred rows at a time.
protocol ListPage: Sendable {
	associatedtype Row: Identifiable & Sendable
	var rows: [Row] { get }
	var next: String? { get }
}

extension CountedPage: ListPage {}
extension TestPage: ListPage {}
extension QuestionPage: ListPage {
	var rows: [Question] { questions }
}
extension RunPage: ListPage {
	var rows: [Run] { runs }
}

/// The rows of one query, read a page at a time. It owns the query its rows answer, the cursor of their next page
/// and which read may still change them, so a page of one query is never appended to the rows of another, a
/// slower read never replaces a newer one, and asking for more never discards a read of the list again.
@MainActor @Observable
final class PagedList<Query: Equatable & Sendable, Page: ListPage> {
	typealias Read = (Query, String?) async throws -> Page

	/// The query the rows answer.
	private(set) var query: Query
	private(set) var rows: [Page.Row] = []
	/// The first page of the latest read: what the server says of the whole list beside its rows.
	private(set) var first: Page?
	/// The latest accepted page, including metadata that may change while the person asks for more.
	private(set) var last: Page?
	private(set) var loading = ListLoading.first
	/// A later read that failed, while the rows read before stay.
	private(set) var notice: String?
	/// A screen with its own notice receives list problems in that same value.
	var onProblem: ((String) -> Void)?
	/// The next page was refused because the list changed since its first page (`moved`).
	private(set) var moved = false
	var hasMore: Bool { next != nil }

	private var next: String?
	/// Counts the reads of the list from its start. One that was overtaken changes nothing, and neither does a
	/// page that was asked for before it.
	private var generation = 0
	private var reloading: Int?
	private var paging: (generation: Int, cursor: String)?
	private var waiters: [UUID: AsyncStream<Void>.Continuation] = [:]
	private let read: Read
	/// Whether an error says the list changed between its pages.
	private let isMoved: (any Error) -> Bool

	init(query: Query, isMoved: @escaping (any Error) -> Bool = { _ in false }, read: @escaping Read) {
		self.query = query
		self.isMoved = isMoved
		self.read = read
	}

	/// Shows another query from its first page; the same query is left as it is.
	@discardableResult
	func show(_ query: Query) async -> Bool {
		guard query != self.query || loading != .done else { return false }
		if query != self.query {
			self.query = query
			if loading != .first { loading = .reading }
			rows = []
			next = nil
		}
		return await reload()
	}

	/// Reads the list again from its start, as far down as it was read, keeping the rows until the reply.
	/// Returns whether this read supplied the rows, so a screen can update what depends on them.
	@discardableResult
	func reload() async -> Bool {
		if case .failed = loading { loading = first == nil ? .first : .reading }
		generation += 1
		let mine = generation
		reloading = mine
		defer {
			if reloading == mine { reloading = nil }
			wakeWaiters()
		}
		let query = query
		let wanted = rows.count
		do {
			let page = try await read(query, nil)
			try Task.checkCancellation()
			guard mine == generation else { return false }
			var rows = page.rows
			var latest = page
			while let after = latest.next, rows.count < wanted {
				latest = try await read(query, after)
				try Task.checkCancellation()
				guard mine == generation else { return false }
				rows += latest.rows
			}
			self.rows = rows
			first = page
			last = latest
			next = latest.next
			moved = false
			notice = nil
			loading = .done
			return true
		} catch is CancellationError {
		} catch where isMoved(error) {
			// The list changed while it was read past its first page: its first page alone is read again.
			guard mine == generation else { return false }
			rows = []
			next = nil
			loading = .reading
			return await reload()
		} catch {
			guard mine == generation else { return false }
			if loading == .done { report(error) } else { loading = .failed(error.shown) }
		}
		return false
	}

	/// Reads the first page alone, after the server refused a later page because the list changed.
	func restart() async {
		loading = .reading
		rows = []
		next = nil
		await reload()
	}

	/// Includes a row just read on its own, even when the following list read failed or did not yet contain it.
	func include(_ row: Page.Row) {
		if !rows.contains(where: { $0.id == row.id }) { rows.insert(row, at: 0) }
		loading = .done
	}

	/// Reads the next page of the query the rows answer, after any active read from its start finishes.
	func more() async {
		while reloading != nil {
			await waitForRead()
			if Task.isCancelled { return }
		}
		while let active = paging, active.generation == generation, active.cursor == next {
			await waitForRead()
			guard !Task.isCancelled else { return }
			// A completed page or a newer query already supplied what this caller waited for.
			guard active.generation == generation, active.cursor == next else { return }
		}
		guard !Task.isCancelled, let cursor = next else { return }
		let mine = generation
		paging = (mine, cursor)
		defer {
			if paging?.generation == mine, paging?.cursor == cursor { paging = nil }
			wakeWaiters()
		}
		let query = query
		do {
			let page = try await read(query, cursor)
			try Task.checkCancellation()
			// A read of the list again, or another page, came first: this page belongs to neither.
			guard mine == generation, cursor == next else { return }
			let known = Set(rows.map(\.id))
			rows += page.rows.filter { !known.contains($0.id) }
			last = page
			next = page.next
		} catch is CancellationError {
		} catch where isMoved(error) {
			guard mine == generation, cursor == next else { return }
			moved = true
			next = nil
		} catch {
			guard mine == generation, cursor == next else { return }
			report(error)
		}
	}

	private func report(_ error: any Error) {
		if let onProblem { onProblem(error.shown) } else { notice = error.shown }
	}

	/// AsyncStream ends a canceled wait without moving the read into a task of its own.
	private func waitForRead() async {
		let id = UUID()
		let (events, continuation) = AsyncStream<Void>.makeStream()
		waiters[id] = continuation
		defer { waiters[id] = nil }
		for await _ in events {}
	}

	private func wakeWaiters() {
		for waiter in waiters.values { waiter.finish() }
		waiters = [:]
	}
}

/// Every test the gate of one change's head counted, as it counted it (decision 0101): the evidence behind the
/// verdict. It reads the run whose gate the change's page shows, so a newer head's results never appear under an
/// older head's gate: a page that reads a new head gets a new one of these, which keeps what the person chose to
/// see. The tally chooses what is shown, and words of a test's name or file narrow it.
@MainActor @Observable
public final class ChangeResults {
	public let attachments: ResultAttachmentScreen
	/// What the rows are filtered by.
	public struct Query: Equatable, Sendable {
		public var standing: ResultStanding?
		public var text = ""
	}

	/// The change whose gate it is. None for a run on a commit no change was reported for.
	public let change: String?
	/// The gate's run. None: nothing a gate counts was reported for the head.
	public let run: String?
	/// The words being typed. `search` reads the list for them once typing pauses.
	public var text: String
	private let list: PagedList<Query, CountedPage>

	public var standing: ResultStanding? { list.query.standing }
	public var rows: [CountedResult] { list.rows }
	/// Every row the gate counts, by standing, whatever is shown.
	public var tally: [ResultStanding: Int] { list.first?.tally ?? [:] }
	public var total: Int { tally.values.reduce(0, +) }
	/// How many rows match what is shown, when the server said.
	public var count: Int? { list.first?.count }
	public var loading: ListLoading { list.loading }
	/// Whether an earlier read supplied the counts and filter controls, even if the current query failed.
	public var hasRead: Bool { list.first != nil }
	public var notice: String? { list.notice }
	/// Says, beside the field, when the search sends only the beginning of what was typed or pasted.
	public var searchNote: String? { cutSearchNote(text) }
	/// The next page was refused because the results changed since the first.
	public var moved: Bool { list.moved }
	public var hasMore: Bool { list.hasMore }

	package init(project: ProjectClient, change: String?, run: String?, query: Query = Query()) {
		attachments = ResultAttachmentScreen(project: project)
		self.change = change
		self.run = run
		text = query.text
		list = PagedList(query: query, isMoved: { $0 is ResultsMoved }) { query, cursor in
			guard let run else { return .none }
			return try await project.results(
				of: run, standing: query.standing, text: query.text, after: cursor
			)
		}
	}

	/// What the person chose to see, for the results of a newer run of the same change.
	var query: Query { list.query }

	/// Reads the first page, once.
	public func load() async {
		guard list.loading == .first else { return }
		await list.reload()
	}

	/// Shows the results of one standing, or all of them.
	public func show(_ standing: ResultStanding?) async {
		await list.show(Query(standing: standing, text: list.query.text))
	}

	/// Reads the list for the words typed.
	public func search() async {
		await list.show(Query(standing: list.query.standing, text: text))
	}

	public func read() async { await list.reload() }
	public func restart() async { await list.restart() }
	public func more() async { await list.more() }

	/// What the change stream told of: read again, if anybody read the list.
	func refresh() async {
		guard list.loading != .first else { return }
		await list.reload()
	}
}

/// What became of reading one test.
public enum TestReading: Equatable, Sendable {
	case reading
	case read(TestDetail)
	/// The project has no such test.
	case missing
	case failed(String)
}

/// Every automated test the project has seen, with a case or tracked without one, and what each one did.
@MainActor @Observable
public final class TestsScreen: ProjectScreen {
	public let attachments: ResultAttachmentScreen
	struct Query: Equatable, Sendable {
		var text = ""
		var unlinked = false
	}

	/// The words being typed. `search` reads the list for them once typing pauses.
	public var text = ""
	private let list: PagedList<Query, TestPage>

	public var unlinked: Bool { list.query.unlinked }
	/// Whether the list shows what was typed and chosen, or the whole list.
	public var isFiltered: Bool { list.query != Query() }
	public var tests: [TestSummary] { list.rows }
	public var loading: ListLoading { list.loading }
	public var notice: String? { list.notice }
	/// Says, beside the field, when the search sends only the beginning of what was typed or pasted.
	public var searchNote: String? { cutSearchNote(text) }
	public var hasMore: Bool { list.hasMore }

	/// Each test as it was last read. A test whose page is not open is read again when it is opened.
	private var details: [String: TestReading] = [:]
	/// Counts the reads of each test, so that a slow one that was overtaken does not replace a newer one.
	private var detailReads: [String: Int] = [:]
	/// How many pages show each test: only these are read again when the project changes.
	private var shown: [String: Int] = [:]
	private let project: ProjectClient

	package init(project: ProjectClient) {
		self.project = project
		attachments = ResultAttachmentScreen(project: project)
		list = PagedList(query: Query()) { query, cursor in
			try await project.tests(text: query.text, unlinked: query.unlinked, after: cursor)
		}
	}

	/// Reads the first page, once.
	public func load() async {
		guard list.loading == .first else { return }
		await list.reload()
	}

	/// Shows only the tests with no case, or all of them.
	public func showUnlinked(_ unlinked: Bool) async {
		await list.show(Query(text: list.query.text, unlinked: unlinked))
	}

	/// Reads the list for the words typed.
	public func search() async {
		await list.show(Query(text: text, unlinked: list.query.unlinked))
	}

	public func read() async { await list.reload() }
	public func more() async { await list.more() }

	public func detail(_ ref: String) -> TestReading? {
		details[ref]
	}

	/// A test's page is open: it is read now, and again whenever the project changes, until it is closed.
	public func open(_ ref: String) async {
		shown[ref, default: 0] += 1
		await readDetail(ref)
	}

	/// A test's page was left.
	public func close(_ ref: String) {
		guard let count = shown[ref] else { return }
		shown[ref] = count > 1 ? count - 1 : nil
	}

	/// Reads one test and its latest results. What was read before stays on screen until the reply.
	public func readDetail(_ ref: String) async {
		if details[ref] == nil { details[ref] = .reading }
		detailReads[ref, default: 0] += 1
		let mine = detailReads[ref]
		do {
			let read = try await project.test(ref).map(TestReading.read) ?? .missing
			guard mine == detailReads[ref] else { return }
			details[ref] = read
		} catch is CancellationError {
			guard mine == detailReads[ref] else { return }
			if details[ref] == .reading { details[ref] = nil }
		} catch {
			guard mine == detailReads[ref] else { return }
			if case .read = details[ref] { return }
			details[ref] = .failed(error.shown)
		}
	}

	public func refresh() async {
		if list.loading != .first { await list.reload() }
		for ref in shown.keys.sorted() { await readDetail(ref) }
	}
}

private func cutSearchNote(_ text: String) -> String? {
	findText(text) == text.trimmingCharacters(in: .whitespacesAndNewlines) ? nil : "Only the beginning of this text is searched."
}
