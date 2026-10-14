import Foundation
import TestSupport
import Testing

@testable import MainworthyClient

@Suite("Changes against the server", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
struct ChangesLiveTests {
	@Test("the head's gate, questions, failures and impact are read, and answering unblocks it")
	func details() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let change = try #require(try await client.reportedChanges().first)
		#expect(change.key == "pr:482" && change.title == "Apply a percentage coupon")
		#expect(change.branch == "coupon-total" && change.head == String(repeating: "3", count: 40))
		#expect(change.state == .open && change.verdict == .blocked)
		let details = try await client.details(of: change)
		#expect(details.base == String(repeating: "1", count: 40))
		#expect(details.gate.verdict == .blocked && !details.gate.stale)
		#expect(details.gate.reason.hasPrefix("blocked:") && details.gate.phrase.contains("1 unexplained"))
		let failed = try #require(details.failing.first)
		#expect(failed.name == "Shop check 1" && failed.caseRef != nil)
		#expect(details.cases.contains { $0.id == failed.caseRef && $0.reasons.contains("failing") })
		let question = try #require(details.questions.first { $0.kind == .failure })
		let byRef = try #require(try await client.question(question.ref))
		#expect(byRef == question && byRef.standing == .counts)
		#expect(try await client.answer(byRef, with: try #require(byRef.choices.first { $0.answer == "flaky" })) == .decided)
		let now = try await client.details(of: change)
		#expect(now.gate.verdict == .passed && now.gate.phrase.contains("1 excused"))
		#expect(!now.questions.contains { $0.kind == .failure })
	}

	@Test("merged and closed changes stay ended with their last gate")
	func ended() async throws {
		for state in ["merged", "closed"] {
			let client = try await Live.signedIn().project(try await Live.project())
			let _: JSONValue = try await client.server.write(
				"change", in: client.key, ["change": "pr:482", "state": .string(state)]
			)
			let change = try #require(try await client.reportedChanges().first)
			#expect(change.state.isEnded && change.state.name == state && change.verdict == .blocked)
			#expect(try await client.details(of: change).gate.verdict == .blocked)
		}
	}
}

@Suite("Change values")
struct ChangeValueTests {
	@Test("new words stay visible")
	func unknown() {
		#expect(ChangeState("paused") == .other("paused") && ChangeState("paused").name == "paused")
		#expect(ChangeVerdict("waiting") == .other("waiting") && ChangeVerdict("waiting").name == "waiting")
	}
}
