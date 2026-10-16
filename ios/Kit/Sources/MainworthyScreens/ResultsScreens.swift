import Foundation
import MainworthyClient
import Observation

/// Whether a list was read: not yet, read, or its first read failed with this sentence.
public enum ListLoading: Equatable, Sendable {
	case first, done, failed(String)
}

/// Every test the gate of one change's head counted, as it counted it (decision 0087): the evidence behind the
/// verdict. It reads the run whose gate the change's page shows, so a newer head's results never appear under an
/// older head's gate: a page that reads a new head gets a new one of these. The tally chooses what is shown, and
/// words of a test's name or file narrow it.
@MainActor @Observable
public final class ChangeResults {
	public let change: String
	/// The gate's run. None: nothing a gate counts was reported for the head.
	public let run: String?
	public private(set) var standing: ResultStanding?
	/// The words the rows are narrowed by. A view sets it and calls `read` once typing pauses.
	public var text = ""
	public private(set) var rows: [CountedResult] = []
	/// Every row the gate counts, by standing, whatever is shown.
	public private(set) var tally: [ResultStanding: Int] = [:]
	/// How many rows match what is shown, when the server said.
	public private(set) var count: Int?
	public private(set) var loading = ListLoading.first
	/// A later read that failed, while the rows read before stay.
	public private(set) var notice: String?
	/// The next page was refused because the results changed since the first: the list is read again.
	public private(set) var moved = false
	public var hasMore: Bool { next != nil }
	public var total: Int { tally.values.reduce(0, +) }
	private var next: String?
	private var reads = 0
	private let project: ProjectClient

	package init(project: ProjectClient, change: String, run: String?) {
		self.project = project
		self.change = change
		self.run = run
	}

	/// Reads the first page, once.
	public func load() async {
		guard loading == .first else { return }
		await read()
	}

	/// Shows the results of one standing, or all of them.
	public func show(_ standing: ResultStanding?) async {
		guard standing != self.standing else { return }
		self.standing = standing
		rows = []
		next = nil
		await read()
	}

	/// Reads the list again from its start, as far down as it was read, keeping what is shown until the reply.
	public func read() async {
		reads += 1
		let mine = reads
		let wanted = rows.count
		do {
			let first = try await page(after: nil)
			var read = first.rows
			var cursor = first.next
			while let after = cursor, read.count < wanted {
				let more = try await page(after: after)
				read += more.rows
				cursor = more.next
			}
			guard mine == reads else { return }
			rows = read
			tally = first.tally
			count = first.count
			next = cursor
			moved = false
			notice = nil
			loading = .done
		} catch is CancellationError {
		} catch is ResultsMoved {
			// The list changed while it was read past its first page: only its first page is read again.
			guard mine == reads else { return }
			await restart()
		} catch {
			guard mine == reads else { return }
			if loading == .done { notice = error.shown } else { loading = .failed(error.shown) }
		}
	}

	/// Reads the first page alone: after the server refused a later page because the results changed.
	public func restart() async {
		rows = []
		next = nil
		await read()
	}

	/// Reads the next page, when the list was scrolled to its end.
	public func more() async {
		guard let cursor = next else { return }
		reads += 1
		let mine = reads
		do {
			let page = try await page(after: cursor)
			guard mine == reads else { return }
			let known = Set(rows.map(\.id))
			rows += page.rows.filter { !known.contains($0.id) }
			tally = page.tally
			next = page.next
		} catch is CancellationError {
		} catch is ResultsMoved {
			guard mine == reads else { return }
			moved = true
			next = nil
		} catch {
			guard mine == reads else { return }
			notice = error.shown
		}
	}

	private func page(after cursor: String?) async throws -> CountedPage {
		guard let run else { return .none }
		return try await project.results(of: run, standing: standing, text: text, after: cursor)
	}

	/// What the change stream told of: read again, if anybody read the list.
	func refresh() async {
		guard loading != .first else { return }
		await read()
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
	/// The words of a test's name or file the list is narrowed by. A view sets it and calls `read` once typing
	/// pauses.
	public var text = ""
	public private(set) var unlinked = false
	public private(set) var tests: [TestSummary] = []
	public private(set) var loading = ListLoading.first
	public private(set) var notice: String?
	public var hasMore: Bool { next != nil }
	private var details: [String: TestReading] = [:]
	/// Counts the reads of each test, so that a slow one that was overtaken does not replace a newer one.
	private var detailReads: [String: Int] = [:]
	private var next: String?
	private var reads = 0
	private let project: ProjectClient

	package init(project: ProjectClient) {
		self.project = project
	}

	/// Reads the first page, once.
	public func load() async {
		guard loading == .first else { return }
		await read()
	}

	/// Shows only the tests with no case, or all of them.
	public func showUnlinked(_ unlinked: Bool) async {
		guard unlinked != self.unlinked else { return }
		self.unlinked = unlinked
		tests = []
		next = nil
		await read()
	}

	/// Reads the list again from its start, as far down as it was read.
	public func read() async {
		reads += 1
		let mine = reads
		let wanted = tests.count
		do {
			var page = try await project.tests(text: text, unlinked: unlinked)
			var read = page.tests
			while let cursor = page.next, read.count < wanted {
				page = try await project.tests(text: text, unlinked: unlinked, after: cursor)
				read += page.tests
			}
			guard mine == reads else { return }
			tests = read
			next = page.next
			notice = nil
			loading = .done
		} catch is CancellationError {
		} catch {
			guard mine == reads else { return }
			if loading == .done { notice = error.shown } else { loading = .failed(error.shown) }
		}
	}

	public func more() async {
		guard let cursor = next else { return }
		reads += 1
		let mine = reads
		do {
			let page = try await project.tests(text: text, unlinked: unlinked, after: cursor)
			guard mine == reads else { return }
			let known = Set(tests.map(\.ref))
			tests += page.tests.filter { !known.contains($0.ref) }
			next = page.next
		} catch is CancellationError {
		} catch {
			guard mine == reads else { return }
			notice = error.shown
		}
	}

	public func detail(_ ref: String) -> TestReading? {
		details[ref]
	}

	/// Reads one test and its latest results. What was read before stays on screen until the reply.
	public func open(_ ref: String) async {
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
		if loading != .first { await read() }
		for ref in details.keys.sorted() { await open(ref) }
	}
}
