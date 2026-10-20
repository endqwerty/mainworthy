import Foundation
import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("Run planner recovery", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
@MainActor
struct RunPlannerTests {
	func screen(_ transport: PlanReplies) async throws -> (RunsScreen, ProjectClient) {
		let key = try await Live.project()
		let client = try await Live.signedIn(transport: transport).project(key)
		return (RunsScreen(project: client,
			permission: Project(key: key, name: key, can: ["read", "plan"]), person: Live.name), client)
	}

	@Test("a committed plan with lost replies retries one command and creates one run")
	func lostPlan() async throws {
		let transport = PlanReplies(.lost)
		let (screen, client) = try await screen(transport)
		let commit = "3333333333333333333333333333333333333333"
		#expect(await screen.plan(name: "Keep this plan", selection: .tag("regression"), commit: commit) == nil)
		#expect(screen.planSubmission?.name == "Keep this plan")
		#expect(screen.savedPlan == nil)
		#expect(screen.notice?.contains("outcome is unknown") == true)
		let notice = screen.notice
		screen.preparePlanner()
		#expect(screen.notice == notice)
		#expect(screen.planSubmission?.name == "Keep this plan")
		await transport.reconnect()
		let run = try #require(await screen.plan(name: "Changed while uncertain", selection: .all))
		#expect(run.name == "Keep this plan")
		#expect(run.accepts == .commit(commit, repo: nil, environment: nil))
		#expect(try await client.runs().runs.filter { $0.name == "Keep this plan" }.count == 1)
		#expect(try await client.slots(of: run.ref).count == 3)
		let inputs = await transport.inputs
		#expect(inputs.count == 3)
		#expect(Set(inputs.compactMap { $0["cmd"]?.string }).count == 1)
		#expect(inputs.allSatisfy { $0 == inputs.first })
		#expect(await transport.lookups == 1)
	}

	@Test("internal, statusless and unreadable receipts keep the committed plan", arguments: [
		PlanReplies.Fault.internalError, .statusless, .unreadable, .unreadableHead
	])
	func uncertainReceipts(_ fault: PlanReplies.Fault) async throws {
		let transport = PlanReplies(fault)
		let (screen, client) = try await screen(transport)
		#expect(await screen.plan(name: "Uncertain plan", selection: .tag("#regression")) == nil)
		#expect(screen.planSubmission?.selection == .tag("#regression"))
		await transport.reconnect()
		let run = try #require(await screen.plan(name: "Different", selection: .all))
		#expect(run.name == "Uncertain plan")
		#expect(try await client.runs().runs.filter { $0.name == "Uncertain plan" }.count == 1)
		#expect(try await client.slots(of: run.ref).count == 3)
		#expect(await transport.inputs.count == 1)
		#expect(await transport.lookups == 1)
	}

	@Test("a missing command replays the identical request after an unreadable receipt")
	func replay() async throws {
		let transport = PlanReplies(.unreadable, command: "none")
		let (screen, client) = try await screen(transport)
		#expect(await screen.plan(name: "Replay once", selection: .folder("Checkout")) == nil)
		await transport.reconnect()
		let run = try #require(await screen.plan(name: "Other", selection: .all))
		#expect(run.name == "Replay once")
		#expect(try await client.runs().runs.filter { $0.name == "Replay once" }.count == 1)
		let inputs = await transport.inputs
		#expect(inputs.count == 2 && inputs[0] == inputs[1])
	}

	@Test("a pending or unreadable command keeps choices until its receipt is recovered", arguments: ["begun", "done", "unknown"])
	func commandNotReadable(_ state: String) async throws {
		let transport = PlanReplies(.internalError, command: state)
		let (screen, _) = try await screen(transport)
		#expect(await screen.plan(name: "Still recording", selection: .all) == nil)
		await transport.reconnect()
		#expect(await screen.plan(name: "Other", selection: .all) == nil)
		#expect(screen.planSubmission?.name == "Still recording")
		#expect(await transport.inputs.count == 1)
		await transport.recordedCommand()
		#expect(await screen.plan(name: "Other", selection: .all)?.name == "Still recording")
	}

	@Test("a definite refusal releases the submitted choices and allows a fresh command")
	func refusal() async throws {
		let transport = PlanReplies(.refused)
		let (screen, client) = try await screen(transport)
		#expect(await screen.plan(name: "Refused plan", selection: .all) == nil)
		#expect(screen.planSubmission == nil && screen.savedPlan == nil)
		#expect(screen.notice == "This plan was refused.")
		await transport.reconnect()
		#expect(await screen.plan(name: "New plan", selection: .all)?.name == "New plan")
		let inputs = await transport.inputs
		#expect(inputs.count == 2)
		#expect(Set(inputs.compactMap { $0["cmd"]?.string }).count == 2)
		#expect(try await client.runs().runs.filter { $0.name == "Refused plan" }.count == 0)
		#expect(try await client.runs().runs.filter { $0.name == "New plan" }.count == 1)
	}

	@Test("a later rejection cannot erase earlier uncertain delivery", arguments: [
		PlanReplies.Fault.lostThenRefused, .internalError, .statusless, .unreadable, .unreadableHead
	])
	func uncertaintySurvivesRefusal(_ fault: PlanReplies.Fault) async throws {
		let transport = PlanReplies(fault, command: "none")
		let (screen, _) = try await screen(transport)
		#expect(await screen.plan(name: "Keep through refusal", selection: .all) == nil)
		let command = try #require(screen.planSubmission?.command)
		await transport.refuseReplay()
		#expect(await screen.plan(name: "Other", selection: .tag("absent")) == nil)
		#expect(screen.planSubmission?.command == command)
		await transport.reconnect()
		await transport.recordedCommand()
		#expect(await screen.plan(name: "Other", selection: .all)?.name == "Keep through refusal")
	}

	@Test("a confirmed receipt survives a failed read without another plan")
	func failedRead() async throws {
		let transport = PlanReplies(.read)
		let (screen, _) = try await screen(transport)
		#expect(await screen.plan(name: "Read again", selection: .all) == nil)
		let receipt = try #require(screen.savedPlan)
		#expect(receipt.slots == 6)
		let notice = screen.notice
		screen.preparePlanner()
		#expect(screen.savedPlan == receipt)
		#expect(screen.notice == notice)
		#expect(screen.notice?.contains("It could not be opened") == true)
		await transport.reconnect()
		#expect(await screen.readPlannedRun()?.ref == receipt.ref)
		#expect(screen.savedPlan == nil && screen.planSubmission == nil)
		#expect(await transport.inputs.count == 1)
		#expect(await transport.lookups == 0)
	}

	@Test("a late successful plan refreshes the list and clears its submitted choices")
	func lateSuccess() async throws {
		let transport = PlanReplies(.held)
		let (screen, _) = try await screen(transport)
		let planning = Task { await screen.plan(name: "Late plan", selection: .all) }
		await transport.wasAsked()
		#expect(screen.planning && screen.planSubmission?.name == "Late plan")
		await transport.release()
		let run = try #require(await planning.value)
		#expect(run.name == "Late plan")
		#expect(screen.runs.first?.ref == run.ref)
		#expect(screen.savedPlan == nil && screen.planSubmission == nil)
		#expect(screen.notice == "\(run.ref) planned with 6 slots; 0 already filled.")
		screen.preparePlanner()
		#expect(screen.notice == nil)
		#expect(screen.runs.first?.ref == run.ref)
		#expect(await transport.inputs.count == 1)
	}

	@Test("an older count does not replace a newer selection, and a failed count is not zero")
	func countRace() async throws {
		let transport = PlanReplies(.heldCount)
		let (screen, _) = try await screen(transport)
		let old = Task { await screen.countCases(.all) }
		await transport.wasAsked()
		await screen.countCases(.tag("regression"))
		#expect(screen.caseCount == .counted(3))
		await transport.release()
		await old.value
		#expect(screen.caseCount == .counted(3))
		await transport.failCount()
		await screen.countCases(.all)
		guard case .failed(let why) = screen.caseCount else {
			Issue.record("a failed count showed a number")
			return
		}
		#expect(why.contains("could not be read"))
		await transport.reconnect()
		await screen.countCases(.tag("absent"))
		#expect(screen.caseCount == .counted(0))
	}
}

/// The server performs real operations. Only their delivery to the app is changed.
actor PlanReplies: Transport {
	enum Fault: Sendable { case lost, internalError, statusless, unreadable, unreadableHead, refused, lostThenRefused, read, held, heldCount }
	let fault: Fault
	var failing = true
	var refusesReplay = false
	var countFails = false
	var command: String?
	private var countReads = 0
	private let asked = AsyncStream.makeStream(of: Void.self)
	private let gate = AsyncStream.makeStream(of: Void.self)
	private(set) var inputs: [JSONValue] = []
	private(set) var lookups = 0
	init(_ fault: Fault, command: String? = nil) { self.fault = fault; self.command = command }
	func reconnect() { failing = false; refusesReplay = false; countFails = false }
	func refuseReplay() { refusesReplay = true }
	func recordedCommand() { command = nil }
	func failCount() { countFails = true }
	func wasAsked() async { for await _ in asked.stream { return } }
	func release() { gate.continuation.yield() }
	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		func reply(_ body: String, status: Int = 200) -> (Data, HTTPURLResponse) {
			(Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
		}
		let operation = request.url?.lastPathComponent
		let input = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data("{}".utf8))
		let refusal = #"{"ok":false,"error":{"code":"invalid","message":"this plan was refused."}}"#
		if operation == "command" {
			lookups += 1
			if let command { return reply(#"{"ok":true,"result":{"state":"\#(command)"}}"#) }
		}
		if operation == "plan" {
			inputs.append(input)
			if refusesReplay || (failing && (fault == .refused || (fault == .lostThenRefused && inputs.count > 1))) {
				return reply(refusal, status: 409)
			}
		}
		let response = try await URLSessionTransport().send(request)
		if operation == "find", input["in"]?.string == "cases", input["select"] != nil {
			countReads += 1
			if countFails { return reply("unreadable count") }
			if fault == .heldCount && countReads == 1 {
				asked.continuation.yield()
				for await _ in gate.stream { break }
			}
		}
		if operation == "get", failing && fault == .read { return reply("unreadable run") }
		guard operation == "plan", failing else { return response }
		switch fault {
		case .lost, .lostThenRefused: throw URLError(.networkConnectionLost)
		case .internalError:
			return reply(#"{"ok":false,"error":{"code":"internal","message":"lost result"}}"#, status: 500)
		case .statusless: return reply(refusal)
		case .unreadable: return reply(#"{"ok":true,"result":{"run":"R-999"}}"#)
		case .unreadableHead: return reply("not JSON")
		case .held:
			asked.continuation.yield()
			for await _ in gate.stream { break }
		case .refused, .read, .heldCount: break
		}
		return response
	}
	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		try await URLSessionTransport().lines(request)
	}
}
