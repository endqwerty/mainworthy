import Foundation
import MainworthyClient
import Testing

@testable import MainworthyScreens

private actor SlotAvailabilityTransport: Transport {
	private var first: JSONValue

	init(state: String, outcome: String, by: String) {
		first = Self.slot(id: 1, state: state, outcome: outcome, by: by)
	}

	private static func slot(id: Int, state: String, outcome: String? = nil, by: String = "other-person") -> JSONValue {
		var fills: [JSONValue] = outcome.map { outcome in
			[["result": .number(Double(id)), "by": .string(by), "method": "human", "outcome": .string(outcome), "steps": .null]]
		} ?? []
		if state == "satisfied" || state == "disputed" {
			fills.append([
				"result": 3, "by": "third-person", "method": "human",
				"outcome": .string(state == "disputed" ? "fail" : "pass"), "steps": .null,
			])
		}
		return [
			"id": .number(Double(id)), "case": .string("C-\(id)"), "title": .string("Case \(id)"), "version": 1,
			"state": .string(state), "work": ["kind": "free"], "fills": .array(fills),
		]
	}

	func satisfy() {
		first = Self.slot(id: 1, state: "satisfied", outcome: "pass")
	}

	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let input = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data())
		let result: JSONValue
		if request.url?.lastPathComponent == "find" {
			result = ["items": .array([first, Self.slot(id: 2, state: "missing")]), "cursor": .null]
		} else if input["refs"]?.array?.first?.string == "R-1" {
			result = [[
				"ref": "R-1", "name": "Review", "origin": "planned", "inProgress": 0, "workUntil": .null,
				"state": "open", "verdict": "pending", "reason": "missing", "createdAt": 1_800_000_000_000,
				"slots": 2, "tally": first["state"]?.string == "skipped" ? ["missing": 2, "skipped": 1] : ["missing": 2], "accepts": ["self": true],
			]]
		} else {
			let ref = input["refs"]?.array?.first?.string ?? "C-1"
			result = [[
				"ref": .string(ref), "version": 1, "title": .string(ref), "pre": "", "steps": [],
				"methods": ["human"], "automate": "none",
			]]
		}
		return (
			try JSONEncoder().encode(JSONValue.object(["ok": true, "result": result])),
			HTTPURLResponse(url: try #require(request.url), statusCode: 200, httpVersion: nil, headerFields: nil)!
		)
	}

	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		throw URLError(.unsupportedURL)
	}
}

@Suite("Run slot availability") @MainActor
struct RunSlotAvailabilityTests {
	private func screen(state: String, outcome: String, by: String = "other-person") async throws
		-> (OpenRunScreen, SlotAvailabilityTransport) {
		let transport = SlotAvailabilityTransport(state: state, outcome: outcome, by: by)
		let server = Server(
			instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: transport)
		let client = server.project("review", identity: "review-identity")
		let screen = OpenRunScreen(
			project: client, run: try await client.run("R-1"),
			permission: Project(key: "review", identity: "review-identity", name: "Review", can: ["read", "produce"]),
			person: "robin")
		await screen.refresh()
		return (screen, transport)
	}

	@Test("Start and recording admit another person while proof is missing", arguments: ["skip", "blocked", "pass"])
	func unfinishedSlotAdmitsAnotherPerson(outcome: String) async throws {
		let (screen, _) = try await screen(state: outcome == "pass" ? "missing" : "skipped", outcome: outcome)
		#expect(screen.firstUnfilled?.id == 1)
		let slot = try #require(screen.slots.first)
		#expect(!screen.isLeftToOthers(slot))
		await screen.execute(slot)
		guard case .read(let execution) = screen.document else { throw ClientError.unreadable }
		#expect(screen.mayRecord(execution))
	}

	@Test("skipped and blocked slots remain in the cases-left count", arguments: ["skip", "blocked"])
	func skippedSlotsRemainInRemainingCount(outcome: String) async throws {
		let (screen, _) = try await screen(state: "skipped", outcome: outcome)
		#expect(screen.run.left == 2)
	}

	@Test("completed or failing external evidence stays read-only", arguments: ["satisfied", "failing", "disputed", "waived"])
	func externalEvidenceStaysReadOnly(state: String) async throws {
		let (screen, _) = try await screen(state: state, outcome: state == "failing" || state == "waived" ? "fail" : "pass")
		#expect(screen.firstUnfilled?.id == 2)
		let slot = try #require(screen.slots.first)
		#expect(screen.isLeftToOthers(slot))
		await screen.execute(slot)
		guard case .read(let execution) = screen.document else { throw ClientError.unreadable }
		#expect(!screen.mayRecord(execution))
	}

	@Test("automatic selection moves past one's own result but leaves corrections available", arguments: ["skip", "blocked", "pass"])
	func ownResultRemainsCorrectable(outcome: String) async throws {
		let (screen, _) = try await screen(state: outcome == "pass" ? "missing" : "skipped", outcome: outcome, by: "robin")
		#expect(screen.firstUnfilled?.id == 2)
		let slot = try #require(screen.slots.first)
		#expect(!screen.isLeftToOthers(slot))
		await screen.execute(slot)
		guard case .read(let execution) = screen.document else { throw ClientError.unreadable }
		#expect(screen.mayRecord(execution))
	}

	@Test("refreshing a completed slot closes recording on a stale execution")
	func refreshedSlotClosesRecording() async throws {
		let (screen, transport) = try await screen(state: "missing", outcome: "pass")
		await screen.execute(try #require(screen.slots.first))
		guard case .read(let execution) = screen.document else { throw ClientError.unreadable }
		#expect(screen.mayRecord(execution))
		await transport.satisfy()
		await screen.refresh()
		#expect(screen.firstUnfilled?.id == 2)
		#expect(screen.isLeftToOthers(execution.slot))
		#expect(!screen.mayRecord(execution))
	}
}
