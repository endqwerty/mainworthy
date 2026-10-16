import Foundation
import TestSupport
import Testing

@testable import MainworthyClient

@Suite("Results and tests against the server", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
struct ResultsLiveTests {
	@Test("a change's results, by standing and by words, count a test tracked without a case")
	func changeResults() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let all = try await client.results(of: "pr:482")
		#expect(all.count == 5 && all.next == nil)
		#expect(all.tally[.pass] == 4 && all.tally[.unexplained] == 1 && all.tally.values.reduce(0, +) == 5)
		// Problems first: the failure nobody has explained, with the question the gate waits for.
		let failed = try #require(all.rows.first)
		#expect(failed.name == "Shop check 1" && failed.standing == .unexplained && failed.outcome == "fail")
		#expect(failed.question?.hasPrefix("Q-") == true && failed.caseRef?.hasPrefix("C-") == true)
		#expect(failed.message == "expected $90.00, got $100.00" && failed.job == "shop")
		let tracked = try #require(all.rows.first { $0.name == "Shipping accepts an address" })
		#expect(tracked.caseRef == nil && tracked.standing == .pass && tracked.file == "tests/shipping.spec.ts")
		let unexplained = try await client.results(of: "pr:482", standing: .unexplained)
		#expect(unexplained.rows.map(\.name) == ["Shop check 1"] && unexplained.tally == all.tally)
		let words = try await client.results(of: "pr:482", text: " shipping ")
		#expect(words.rows.map(\.test) == [tracked.test] && words.count == 1)
	}

	@Test("the tests, those with no case, and one test with its latest results")
	func tests() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let all = try await client.tests()
		#expect(all.tests.count == 5 && all.next == nil)
		let unlinked = try await client.tests(unlinked: true)
		let tracked = try #require(unlinked.tests.first)
		#expect(unlinked.tests.count == 1 && tracked.name == "Shipping accepts an address" && tracked.caseRef == nil)
		#expect(try await client.tests(text: "check 2").tests.map(\.name) == ["Shop check 2"])
		let detail = try #require(try await client.test(tracked.ref))
		#expect(detail.caseRef == nil && detail.key == "tests/shipping.spec.ts::shipping::address")
		let result = try #require(detail.results.first)
		#expect(result.outcome == "pass" && result.change == "pr:482" && result.job == "shop")
		#expect(result.commit == String(repeating: "3", count: 40) && result.build == nil)
		#expect(try await client.test("T-999") == nil)
	}

	@Test("a later page asked for after the results changed is refused as moved")
	func moved() async throws {
		let server = Live.server()
		_ = try await server.signIn(Live.owner)
		let client = server.project(try await Live.project())
		let _: JSONValue = try await server.write("report", in: client.key, [
			"target": ["commit": .string(String(repeating: "3", count: 40)), "repo": "acme/shop", "pr": 482],
			"job": "bulk",
			"results": .array((1...120).map { number in
				["test": ["key": .string("bulk-\(number)"), "name": .string("Bulk \(number)")], "outcome": "pass"]
			}),
		])
		let first = try await client.results(of: "pr:482")
		#expect(first.rows.count == 100 && first.count == 125)
		let cursor = try #require(first.next)
		let failure = try #require(try await client.questions(open: true, kind: .failure).questions.first)
		_ = try await client.answer(failure, with: try #require(failure.choices.first { $0.answer == "flaky" }))
		await #expect(throws: ResultsMoved.self) { try await client.results(of: "pr:482", after: cursor) }
		let again = try await client.results(of: "pr:482")
		#expect(again.tally[.excused] == 1 && (again.tally[.unexplained] ?? 0) == 0)
	}

	@Test("a build is a link only when it is a web address")
	func buildLinks() async throws {
		let server = Live.server()
		_ = try await server.signIn(Live.owner)
		let client = server.project(try await Live.project())
		for (job, build) in [("web", "https://ci.example.com/run/7"), ("file", "file:///etc/passwd")] {
			let _: JSONValue = try await server.write("report", in: client.key, [
				"target": ["commit": .string(String(repeating: "3", count: 40)), "repo": "acme/shop", "pr": 482],
				"job": .string(job), "buildUrl": .string(build),
				"results": [["test": ["key": .string("build-\(job)")], "outcome": "pass"]],
			])
		}
		let rows = try await client.results(of: "pr:482", text: "build-").rows
		#expect(rows.first { $0.job == "web" }?.build == URL(string: "https://ci.example.com/run/7"))
		#expect(rows.contains { $0.job == "file" } && rows.first { $0.job == "file" }?.build == nil)
	}
}
