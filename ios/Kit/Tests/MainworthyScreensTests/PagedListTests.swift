import Foundation
import MainworthyClient
import Testing

@testable import MainworthyScreens

/// The rules of a list read a page at a time, with reads the test lets finish in the order it chooses.
@Suite("A list read a page at a time")
@MainActor
struct PagedListTests {
	struct Row: Identifiable, Sendable, Equatable {
		let id: String
	}

	struct Page: ListPage {
		let rows: [Row]
		let next: String?
	}

	/// Reads that wait until the test answers them, in the order they were asked.
	@MainActor final class Reads {
		struct Asked {
			let query: String
			let cursor: String?
			let reply: CheckedContinuation<Page, any Error>
		}

		var asked: [Asked] = []

		func read(_ query: String, _ cursor: String?) async throws -> Page {
			try await withCheckedThrowingContinuation { asked.append(Asked(query: query, cursor: cursor, reply: $0)) }
		}

		/// Waits until `count` reads were asked for.
		func until(_ count: Int) async {
			while asked.count < count { await Task.yield() }
		}

		func answer(_ index: Int, _ rows: [String], next: String?) {
			asked[index].reply.resume(returning: Page(rows: rows.map(Row.init), next: next))
		}
	}

	func list(_ reads: Reads) -> PagedList<String, Page> {
		PagedList(query: "") { query, cursor in try await reads.read(query, cursor) }
	}

	@Test("a page asked for before the list was read again is not appended to the new rows")
	func moreDuringReload() async {
		let reads = Reads()
		let list = list(reads)
		let first = Task { await list.reload() }
		await reads.until(1)
		reads.answer(0, ["a"], next: "p2")
		await first.value
		let more = Task { await list.more() }
		await reads.until(2)
		let again = Task { await list.reload() }
		await reads.until(3)
		reads.answer(2, ["a", "b"], next: "p2'")
		await again.value
		reads.answer(1, ["old"], next: nil)
		await more.value
		#expect(list.rows.map(\.id) == ["a", "b"] && list.hasMore)
	}

	@Test("asking for more does not discard a read of the list again")
	func reloadOutlivesMore() async {
		let reads = Reads()
		let list = list(reads)
		let first = Task { await list.reload() }
		await reads.until(1)
		reads.answer(0, ["a"], next: "p2")
		await first.value
		let again = Task { await list.reload() }
		await reads.until(2)
		let more = Task { await list.more() }
		await reads.until(3)
		reads.answer(2, ["stale"], next: nil)
		await more.value
		reads.answer(1, ["a", "new"], next: nil)
		await again.value
		#expect(list.rows.map(\.id) == ["a", "new"] && !list.hasMore)
	}

	@Test("a page is read for the query its rows answer, not for words typed since")
	func typedQuery() async {
		let reads = Reads()
		let list = list(reads)
		let first = Task { await list.show("cart") }
		await reads.until(1)
		reads.answer(0, ["a"], next: "p2")
		await first.value
		let more = Task { await list.more() }
		await reads.until(2)
		#expect(reads.asked[1].query == "cart" && reads.asked[1].cursor == "p2")
		reads.answer(1, ["b"], next: nil)
		await more.value
		let other = Task { await list.show("coupon") }
		await reads.until(3)
		#expect(reads.asked[2].query == "coupon" && reads.asked[2].cursor == nil && list.rows.isEmpty)
		reads.answer(2, ["c"], next: nil)
		await other.value
		#expect(list.rows.map(\.id) == ["c"] && list.query == "coupon")
	}

	@Test("a slower read of the list does not replace a newer one")
	func overtaken() async {
		let reads = Reads()
		let list = list(reads)
		let older = Task { await list.reload() }
		await reads.until(1)
		let newer = Task { await list.reload() }
		await reads.until(2)
		reads.answer(1, ["new"], next: nil)
		await newer.value
		reads.answer(0, ["old"], next: nil)
		await older.value
		#expect(list.rows.map(\.id) == ["new"])
	}
}
