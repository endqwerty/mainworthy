import Foundation
import TestSupport
import Testing

@testable import MainworthyClient
@testable import MainworthyScreens

@Suite("Run corrections and drafts", .enabled(if: Live.isRunning, "live server"))
@MainActor struct RunsRegressionTests {
	func setup() async throws -> (OpenRunScreen, ProjectClient) {
		let key = try await Live.project()
		let client = try await Live.signedIn().project(key)
		let runs = RunsScreen(
			project: client, permission: Project(key: key, identity: client.identity, name: key, can: ["read", "produce", "plan"]),
			person: Live.name)
		await runs.refresh()
		let run = runs.open(try #require(runs.runs.first))
		await run.refresh()
		return (run, client)
	}
	@Test("Undo restores the previous failure's marked step")
	func undoFailureStep() async throws {
		var (run, client) = try await setup()
		let slot = try #require(run.firstUnfilled)
		await run.execute(slot)
		guard case .read(let first) = run.document else {
			Issue.record("no case")
			return
		}
		let step = try #require(first.content.steps.first)
		run.mark(step)
		run.note = "Failed at shipping"
		#expect(await run.record(first, outcome: .fail))
		run = OpenRunScreen(project: client, run: run.run, permission: run.permission, person: Live.name)
		await run.refresh()
		await run.execute(try #require(run.slots.first { $0.id == slot.id }))
		guard case .read(let second) = run.document else {
			Issue.record("no case")
			return
		}
		#expect(await run.record(second, outcome: .pass))
		await run.undo()
		let current = try #require(run.slots.first { $0.id == slot.id }?.ownFill(by: Live.name))
		#expect(current.outcome == .manual(.fail))
		#expect(current.note == "Failed at shipping")
		let timeline: JSONValue = try await client.server.read(
			"timeline", in: client.key, ["ref": .string(try #require(slot.caseRef))])
		let restored = try #require(
			timeline["entries"]?.array?.first { $0["id"]?.number == Double(current.result) })
		print("restored failure step: \(String(describing: restored["atStep"])), expected \(step.id)")
		#expect(restored["atStep"]?.string == step.id)
	}
	@Test("opening another slot keeps each slot's draft")
	func navigationKeepsDrafts() async throws {
		let (run, _) = try await setup()
		// Two slots nobody has filled: one the pipeline filled is left to it and takes no step mark.
		let first = try #require(run.firstUnfilled)
		let second = try #require(run.slots.last { $0.fills.isEmpty && $0.id != first.id })
		await run.execute(first)
		guard case .read(let shown) = run.document else {
			Issue.record("no case")
			return
		}
		let step = try #require(shown.content.steps.first)
		run.note = "First slot draft"
		run.mark(step)
		await run.execute(second)
		run.note = "Second slot draft"
		await run.execute(first)
		#expect(run.note == "First slot draft" && run.failedStep == step.id)
		await run.execute(second)
		#expect(run.note == "Second slot draft" && run.failedStep == nil)
	}
	@Test("Undo keeps the draft of the next slot")
	func undoKeepsNextDraft() async throws {
		let (run, _) = try await setup()
		await run.execute(try #require(run.firstUnfilled))
		guard case .read(let first) = run.document else {
			Issue.record("no case")
			return
		}
		#expect(await run.record(first, outcome: .pass))
		guard case .read(let second) = run.document else {
			Issue.record("no next case")
			return
		}
		let step = try #require(second.content.steps.first)
		run.note = "Keep this observation for the second case"
		run.mark(step)
		await run.undo()
		await run.execute(try #require(run.slots.first { $0.id == second.slot.id }))
		print("draft after Undo and return: '\(run.note)', mark: \(String(describing: run.failedStep))")
		#expect(run.note == "Keep this observation for the second case")
		#expect(run.failedStep == step.id)
	}
}

actor FailAfterPlanTransport: Transport {
	private let live = URLSessionTransport()
	private var failReads = false
	private(set) var planned: String?
	func reconnect() { failReads = false }
	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		if failReads && request.url?.lastPathComponent != "plan" { throw URLError(.cannotConnectToHost) }
		let reply = try await live.send(request)
		if request.url?.lastPathComponent == "plan" {
			let body = try JSONDecoder().decode(JSONValue.self, from: reply.0)
			planned = body["result"]?["run"]?.string
			failReads = planned != nil
		}
		return reply
	}
	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		try await live.lines(request)
	}
}

@Suite("Planning after a saved run", .enabled(if: Live.isRunning, "live server"))
@MainActor struct PlanReadFailureTests {
	@Test("a committed plan remains reported when its follow-up read fails")
	func savedPlanReadFailure() async throws {
		let key = try await Live.project()
		let transport = FailAfterPlanTransport()
		let server = Server(instance: Live.instance, secrets: MemoryStore(), transport: transport)
		_ = try await server.signIn(.password(name: Live.name, password: Live.password))
		let client = try await server.project(key)
		let runs = RunsScreen(
			project: client, permission: Project(key: key, identity: client.identity, name: key, can: ["read", "plan"]),
			person: Live.name)
		let returned = await runs.plan(name: "Saved before read failed", selection: .all)
		let savedRef = try #require(await transport.planned)
		let actual = try await Live.signedIn().project(key).run(savedRef)
		print(
			"plan exists on server: \(actual.ref) '\(actual.name)'; returned: \(String(describing:returned)); notice: \(runs.notice ?? "nil")"
		)
		#expect(actual.name == "Saved before read failed")
		#expect(runs.notice?.contains(savedRef) == true)
		_ = await runs.plan(name: "Saved before read failed", selection: .all)
		let actualRuns = try await Live.signedIn().project(key).runs().runs
		let duplicates = actualRuns.filter { $0.name == "Saved before read failed" }
		print("retry created \(duplicates.count) saved runs with the same name")
		#expect(duplicates.count == 1)
		#expect(runs.savedPlan?.ref == savedRef)
		await transport.reconnect()
		let reopened = try #require(await runs.readPlannedRun())
		#expect(reopened.ref == savedRef && runs.savedPlan == nil)
		#expect(runs.runs.contains { $0.ref == savedRef })
		let afterRetry = try await Live.signedIn().project(key).runs().runs
		#expect(afterRetry.filter { $0.name == "Saved before read failed" }.count == 1)
	}
}
