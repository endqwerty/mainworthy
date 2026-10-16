import Foundation
import MainworthyClient
import Observation

/// Whether a list was read: not yet, read, or its first read failed with this sentence.
public enum ListLoading: Equatable, Sendable {
	case first, done, failed(String)
}

/// A page of a list the server reads a hundred rows at a time.
protocol ListPage: Sendable {
	associatedtype Row: Identifiable & Sendable
	var rows: [Row] { get }
	var next: String? { get }
}

extension CountedPage: ListPage {}
extension TestPage: ListPage {}

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
	private(set) var loading = ListLoading.first
	/// A later read that failed, while the rows read before stay.
	private(set) var notice: String?
	/// The next page was refused because the list changed since its first page (`moved`).
	private(set) var moved = false
	var hasMore: Bool { next != nil }

	private var next: String?
	/// Counts the reads of the list from its start. One that was overtaken changes nothing, and neither does a
	/// page that was asked for before it.
	private var generation = 0
	private let read: Read
	/// Whether an error says the list changed between its pages.
	private let isMoved: (any Error) -> Bool

	init(query: Query, isMoved: @escaping (any Error) -> Bool = { _ in false }, read: @escaping Read) {
		self.query = query
		self.isMoved = isMoved
		self.read = read
	}

	/// Shows another query from its first page; the same query is left as it is.
	func show(_ query: Query) async {
		guard query != self.query || loading != .done else { return }
		if query != self.query {
			self.query = query
			rows = []
			next = nil
		}
		await reload()
	}

	/// Reads the list again from its start, as far down as it was read, keeping the rows until the reply.
	func reload() async {
		generation += 1
		let mine = generation
		let query = query
		let wanted = rows.count
		do {
			let page = try await read(query, nil)
			var rows = page.rows
			var cursor = page.next
			while let after = cursor, rows.count < wanted {
				let more = try await read(query, after)
				rows += more.rows
				cursor = more.next
			}
			guard mine == generation else { return }
			self.rows = rows
			first = page
			next = cursor
			moved = false
			notice = nil
			loading = .done
		} catch is CancellationError {
		} catch where isMoved(error) {
			// The list changed while it was read past its first page: its first page alone is read again.
			guard mine == generation else { return }
			rows = []
			next = nil
			await reload()
		} catch {
			guard mine == generation else { return }
			if loading == .done { notice = error.shown } else { loading = .failed(error.shown) }
		}
	}

	/// Reads the first page alone, after the server refused a later page because the list changed.
	func restart() async {
		rows = []
		next = nil
		await reload()
	}

	/// Reads the next page of the query the rows answer.
	func more() async {
		guard let cursor = next else { return }
		let mine = generation
		let query = query
		do {
			let page = try await read(query, cursor)
			// A read of the list again, or another page, came first: this page belongs to neither.
			guard mine == generation, cursor == next else { return }
			let known = Set(rows.map(\.id))
			rows += page.rows.filter { !known.contains($0.id) }
			next = page.next
		} catch is CancellationError {
		} catch where isMoved(error) {
			guard mine == generation, cursor == next else { return }
			moved = true
			next = nil
		} catch {
			guard mine == generation, cursor == next else { return }
			notice = error.shown
		}
	}
}

/// Every test the gate of one change's head counted, as it counted it (decision 0087): the evidence behind the
/// verdict. It reads the run whose gate the change's page shows, so a newer head's results never appear under an
/// older head's gate: a page that reads a new head gets a new one of these, which keeps what the person chose to
/// see. The tally chooses what is shown, and words of a test's name or file narrow it.
@MainActor @Observable
public final class ChangeResults {
	/// What the rows are filtered by.
	public struct Query: Equatable, Sendable {
		public var standing: ResultStanding?
		public var text = ""
	}

	public let change: String
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
	public var notice: String? { list.notice }
	/// The next page was refused because the results changed since the first.
	public var moved: Bool { list.moved }
	public var hasMore: Bool { list.hasMore }

	package init(project: ProjectClient, change: String, run: String?, query: Query = Query()) {
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
