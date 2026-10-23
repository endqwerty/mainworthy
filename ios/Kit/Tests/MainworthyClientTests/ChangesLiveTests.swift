import Foundation
import TestSupport
import Testing

@testable import MainworthyClient

@Suite("Changes against the server", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
struct ChangesLiveTests {
	@Test("all 450 affected cases are read across impact pages, restarting after a write", arguments: [false, true])
	func impactPages(_ move: Bool) async throws {
		let server = Live.server()
		_ = try await server.signIn(Live.owner)
		let client = try await server.project(try await Live.project())
		let edits: [JSONValue] = (1...450).map { index in
			["op": "create", "outline": .string("Affected case \(index)\n  Check > Works"), "covers": ["REQ-396"]]
		}
		let _: JSONValue = try await server.write("propose", in: client.key, ["edits": .array(edits)])
		let _: JSONValue = try await server.write("report", in: client.key, [
			"target": ["commit": "iosimpact396", "pr": 396, "title": "REQ-396: review affected cases"],
			"results": [["test": ["key": "ios-impact"], "outcome": "pass"]],
		])
		let reader = Server(instance: Live.instance, secrets: MemoryStore(), transport: MovingImpact(client: client, move: move))
		_ = try await reader.signIn(Live.owner)
		let detail = try await reader.project(client.key).details(of: "pr:396")
		let count = move ? 451 : 450
		#expect(detail.caseCount == count)
		#expect(detail.cases.count == count)
		#expect(Set(detail.cases.map(\.id)).count == count)
		#expect(detail.cases.map(\.title) == (1...count).map { "Affected case \($0)" })
	}

	actor MovingImpact: Transport {
		let client: ProjectClient
		private var move: Bool
		private let network = URLSessionTransport()

		init(client: ProjectClient, move: Bool) { self.client = client; self.move = move }

		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			if move, request.url?.lastPathComponent == "impact", let body = request.httpBody,
				try JSONDecoder().decode(JSONValue.self, from: body)["cursor"]?.string != nil {
				move = false
				let _: JSONValue = try await client.server.write("propose", in: client.key, [
					"edits": [["op": "create", "outline": "Affected case 451\n  Check > Works", "covers": ["REQ-396"]]],
				])
			}
			return try await network.send(request)
		}

		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			try await network.lines(request)
		}
	}

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
		#expect((try await client.answer(byRef, with: try #require(byRef.choices.first { $0.answer == "flaky" }))).isDecided)
		let now = try await client.details(of: change)
		#expect(now.gate.verdict == .passed && now.gate.phrase.contains("1 excused"))
		#expect(!now.questions.contains { $0.kind == .failure })
	}

	@Test("a detail labels the new head whose gate was read after the list")
	func headMoves() async throws {
		let server = Live.server()
		_ = try await server.signIn(Live.owner)
		let client = try await server.project(try await Live.project())
		let shown = try #require(try await client.reportedChanges().first)
		let before = try await client.details(of: shown)
		let head = String(format: "%040x", 4)
		let _: JSONValue = try await server.write("report", in: client.key, [
			"target": ["commit": .string(head), "repo": "acme/shop", "branch": "new-coupon", "pr": 482],
			"job": "review", "results": [["test": ["key": "review-pass"], "outcome": "pass"]]
		])
		let detail = try await client.details(of: shown)
		print("HEAD_RACE old=\(shown.head ?? "nil") server=\(head) " +
			"detail=\(detail.change.head ?? "nil") before=\(before.gate.verdict.name) " +
			"detailGate=\(detail.gate.verdict.name)")
		#expect(detail.change.head == head, "the newer gate must not be labelled with the older head")
		#expect(detail.gate.verdict == .passed && detail.failing.isEmpty)
		#expect(detail.change.branch == "coupon-total")
	}

	actor MovingHead: Transport {
		let client: ProjectClient
		private var left: Int
		private var number = 3
		private let network = URLSessionTransport()

		init(client: ProjectClient, moves: Int) { self.client = client; left = moves }

		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			// Move the change between the gate and its run row. Both replies still come from the real server.
			if request.url?.lastPathComponent == "get", left > 0 {
				left -= 1
				number += 1
				let _: JSONValue = try await client.server.write("report", in: client.key, [
					"target": ["commit": .string(String(format: "%040x", number)), "repo": "acme/shop",
						"branch": "coupon-total", "pr": 482],
					"job": "review", "results": [["test": ["key": "review-pass"], "outcome": "pass"]]
				])
			}
			return try await network.send(request)
		}

		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			try await network.lines(request)
		}
	}

	@Test("a head moving between the gate and run is reread or reported, never combined", arguments: [1, 2])
	func inFlightMoves(_ moves: Int) async throws {
		let writer = Live.server()
		_ = try await writer.signIn(Live.owner)
		let client = try await writer.project(try await Live.project())
		let shown = try #require(try await client.reportedChanges().first)
		let reader = Server(
			instance: Live.instance, secrets: MemoryStore(), transport: MovingHead(client: client, moves: moves)
		)
		_ = try await reader.signIn(Live.owner)
		do {
			let detail = try await reader.project(client.key).details(of: shown)
			#expect(moves == 1, "two moving reads must say the change moved")
			#expect(detail.change.head == String(format: "%040x", 4) && detail.gate.verdict == .passed)
			#expect(detail.failing.isEmpty)
			print("IN_FLIGHT moves=\(moves) head=\(detail.change.head ?? "nil") gate=\(detail.gate.verdict.name)")
		} catch {
			#expect(moves == 2)
			#expect(error.localizedDescription == "This change moved while it was read. Pull down to read it again.")
			print("IN_FLIGHT moves=\(moves) error=\(error.localizedDescription)")
		}
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

@Suite("Change landings against the server", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
struct ChangeLandingLiveTests {
	@Test("a landing that is another commit has its own gate; the change's gate stays the head's")
	func rebased() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let head = String(repeating: "3", count: 40)
		let landed = String(format: "%040x", 9)
		let _: JSONValue = try await client.server.write("change", in: client.key, [
			"change": "pr:482", "state": "merged", "head": .string(head),
			"landing": ["commit": .string(landed), "branch": "main"],
		])
		let change = try #require(try await client.reportedChanges().first)
		let expected = LandedCommit(Wire.ChangeLanding(
			commit: landed, branch: "main", run: nil, verdict: "pending",
			reason: "pending: nothing a gate counts has been reported for this commit", waiting: nil
		))
		#expect(change.head == head && change.verdict == .blocked && change.landing == .asCommit(expected))
		let detail = try await client.details(of: change)
		#expect(detail.change.landing == .asCommit(expected) && detail.gate.verdict == .blocked)
	}
	@Test("a fast-forward keeps its reported pass beside the current blocked head")
	func receipt() async throws {
		let client = try await Live.signedIn().project(try await Live.project())
		let before = try await client.details(of: "pr:482")
		let question = try #require(before.questions.first { $0.kind == .failure })
		let choice = try #require(question.choices.first { $0.answer == "flaky" })
		_ = try await client.answer(question, with: choice)
		let head = try #require(before.change.head)
		let _: JSONValue = try await client.server.write("change", in: client.key, [
			"change": "pr:482", "state": "merged", "head": .string(head),
			"landing": ["commit": .string(head), "branch": "main"],
		])
		let detail = try await client.details(of: "pr:482")
		let receipt = try #require(detail.mergeReceipt)
		#expect(receipt.head == head && receipt.verdict == .passed)
		#expect(detail.gate.verdict == .blocked)
		let page = try await client.receiptResults(receipt.id)
		#expect(page.results.contains { $0.standing == "excused" && $0.answer == "flaky" })
	}

}

@Suite("Change values")
struct ChangeValueTests {
	@Test("new words stay visible")
	func unknown() {
		#expect(ChangeState("paused") == .other("paused") && ChangeState("paused").name == "paused")
		#expect(ChangeVerdict("waiting") == .other("waiting") && ChangeVerdict("waiting").name == "waiting")
	}

	@Test("a landing on the head is the head; another commit keeps its own gate")
	func landing() {
		let wire = Wire.ChangeLanding(commit: "abc1234", branch: "main", run: "R-2", verdict: "blocked", reason: "blocked", waiting: nil)
		#expect(ChangeLanding(wire, head: "abc1234") == .asHead(branch: "main"))
		#expect(ChangeLanding(wire, head: "def5678") == .asCommit(LandedCommit(wire)))
		#expect(ChangeLanding(nil, head: "abc1234") == nil)
	}
}
