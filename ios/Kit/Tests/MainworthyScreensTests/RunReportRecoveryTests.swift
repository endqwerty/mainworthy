import Foundation
import TestSupport
import Testing

@testable import MainworthyClient
@testable import MainworthyScreens

actor HeldReportRead {
	private let asked = AsyncStream.makeStream(of: Void.self)
	private let released = AsyncStream.makeStream(of: Void.self)
	func waitUntilAsked() async { for await _ in asked.stream { break } }
	func release() { released.continuation.yield() }
	func hold() async {
		asked.continuation.yield()
		for await _ in released.stream { break }
	}
}

actor ReportReplies: Transport {
	enum Fault: Sendable { case lost, unreadable, internalError, refused, statuslessRefusal, lostThenRefused }
	var fault: Fault?
	var commandState: String?
	var failReads = false
	func refuseReads(_ value: Bool) { failReads = value }
	private var heldReads: [HeldReportRead] = []
	func holdNextRead() -> HeldReportRead {
		let held = HeldReportRead()
		heldReads.append(held)
		return held
	}
	private(set) var inputs: [JSONValue] = []
	private(set) var lookups = 0
	func fail(_ fault: Fault, command: String? = nil) { self.fault = fault; commandState = command }
	func reconnect() { fault = nil; commandState = nil }
	func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
		let op = request.url?.lastPathComponent
		let input = try JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data("{}".utf8))
		func reply(_ body: String, _ status: Int = 200) -> (Data, HTTPURLResponse) {
			(Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
		}
		if op == "get" {
			if !heldReads.isEmpty { await heldReads.removeFirst().hold() }
			if failReads { throw URLError(.cannotConnectToHost) }
		}
		if op == "command" {
			lookups += 1
			if let commandState { return reply(#"{"ok":true,"result":{"state":"\#(commandState)"}}"#) }
		}
		if op == "report" {
			inputs.append(input)
			if fault == .refused || fault == .statuslessRefusal || (fault == .lostThenRefused && inputs.count > 1) {
				return reply(#"{"ok":false,"error":{"code":"conflict","message":"Report refused."}}"#, fault == .statuslessRefusal ? 200 : 409)
			}
		}
		let response = try await URLSessionTransport().send(request)
		if op == "report", let fault {
			switch fault {
			case .lost, .lostThenRefused: throw URLError(.networkConnectionLost)
			case .unreadable: return reply("unreadable receipt")
			case .internalError: return reply(#"{"ok":false,"error":{"code":"internal","message":"Receipt unavailable."}}"#, 500)
			case .refused, .statuslessRefusal: break
			}
		}
		return response
	}
	func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
		try await URLSessionTransport().lines(request)
	}
}

@Suite("Run report recovery", .enabled(if: Live.isRunning, "needs live server"))
@MainActor struct RunReportRecoveryTests {
	func setup() async throws -> (OpenRunScreen, ProjectClient, ReportReplies, RunExecution) {
		let transport = ReportReplies()
		let client = try await Live.signedIn(transport: transport).project(try await Live.project())
		let run = try #require(try await client.runs().runs.first { $0.name == "Checkout regression" })
		let screen = OpenRunScreen(project: client, run: run,
			permission: Project(key: client.key, identity: client.identity, name: client.key, can: ["read", "produce"]), person: Live.name)
		await screen.refresh()
		await screen.execute(try #require(screen.firstUnfilled))
		guard case .read(let execution) = screen.document else { throw ClientError.unreadable }
		return (screen, client, transport, execution)
	}
	func results(_ client: ProjectClient, _ execution: RunExecution) async throws -> [JSONValue] {
		let timeline: JSONValue = try await client.server.read("timeline", in: client.key,
			["ref": .string(try #require(execution.slot.caseRef))])
		return timeline["entries"]?.array?.filter { $0["t"]?.string == "result" } ?? []
	}

	@Test("lost report receipts then Record recover one result and the submitted note", arguments: [
		ReportReplies.Fault.lost, .unreadable, .internalError, .lostThenRefused
	])
	func lostReport(_ fault: ReportReplies.Fault) async throws {
		let (screen, client, transport, execution) = try await setup()
		screen.note = "Original note"
		await transport.fail(fault)
		#expect(await screen.record(execution, outcome: .fail) == false)
		screen.note = "New draft"
		await transport.reconnect()
		#expect(await screen.record(execution, outcome: .pass))
		let fill = try #require(screen.slots.first { $0.id == execution.slot.id }?.ownFill(by: Live.name))
		#expect(fill.outcome == .manual(.fail) && fill.note == "Original note")
		let inputs = await transport.inputs
		#expect(Set(inputs.compactMap { $0["cmd"]?.string }).count == 1)
		#expect(await transport.lookups == 1)
		#expect(try await results(client, execution).count == 1)
		await screen.execute(try #require(screen.slots.first { $0.id == execution.slot.id }))
		#expect(screen.note == "New draft")
	}

	@Test("missing command replays identical report; pending command waits", arguments: ["none", "begun", "done", "unknown"])
	func commandRecovery(_ state: String) async throws {
		let (screen, client, transport, execution) = try await setup()
		await transport.fail(.unreadable)
		#expect(await screen.record(execution, outcome: .fail) == false)
		await transport.reconnect()
		await transport.fail(.unreadable, command: state)
		let recovered = await screen.record(execution, outcome: .pass)
		#expect(recovered == false)
		let inputs = await transport.inputs
		#expect(inputs.count == (state == "none" ? 2 : 1))
		#expect(inputs.allSatisfy { $0 == inputs.first })
		await transport.reconnect()
		#expect(await screen.record(execution, outcome: .pass))
		#expect(try await results(client, execution).count == 1)
		#expect(screen.slots.first { $0.id == execution.slot.id }?.ownFill(by: Live.name)?.outcome == .manual(.fail))
	}

	@Test("a definite refusal allows a new report; uncertainty survives a later refusal", arguments: [false, true])
	func refusal(_ earlierUncertainty: Bool) async throws {
		let (screen, _, transport, execution) = try await setup()
		if earlierUncertainty {
			await transport.fail(.unreadable)
			#expect(await screen.record(execution, outcome: .fail) == false)
		}
		await transport.fail(.refused, command: "none")
		#expect(await screen.record(execution, outcome: .fail) == false)
		await transport.reconnect()
		#expect(await screen.record(execution, outcome: .pass))
		let inputs = await transport.inputs
		#expect(Set(inputs.compactMap { $0["cmd"]?.string }).count == (earlierUncertainty ? 1 : 2))
		#expect(screen.slots.first { $0.id == execution.slot.id }?.ownFill(by: Live.name)?.outcome == .manual(earlierUncertainty ? .fail : .pass))
	}

	@Test("a refused resend can be set aside after a lost correction reply", arguments: [false, true])
	func refusedResend(_ failedRead: Bool) async throws {
		let (screen, client, transport, execution) = try await setup()
		#expect(await screen.record(execution, outcome: .pass))
		let slot = try #require(screen.slots.first { $0.id == execution.slot.id })
		await screen.execute(slot)
		guard case .read(let shown) = screen.document else { throw ClientError.unreadable }
		let original = try #require(slot.ownFill(by: Live.name))
		let other = try await Live.signedIn().project(client.key)
		let _: JSONValue = try await other.server.write("report", in: client.key, ["run": .string(execution.run),
			"results": [["test": ["case": .string(try #require(execution.slot.caseRef))],
				"outcome": "blocked", "corrects": .number(Double(original.result))]]])
		screen.note = "Keep this observation"
		screen.mark(try #require(shown.content.steps.first))
		await transport.fail(.lost)
		#expect(await screen.record(shown, outcome: .fail) == false)
		await transport.reconnect()
		await screen.retryReport()
		await screen.refresh()
		await screen.retryReport()
		#expect(screen.hasPendingReport(for: shown))
		#expect(screen.notice == "The server refused this report's resend. Result \(original.result) was already corrected; read the latest results and correct the current result instead\nThe earlier attempt may still have been recorded. Retry the same report or set it aside for this slot.")
		#expect(try await results(client, shown).count == 2)
		#expect(screen.canSetAsideReport(shown))
		if failedRead {
			await transport.refuseReads(true)
			await screen.setAsideReport(shown)
			#expect(screen.hasPendingReport(for: shown))
			#expect(screen.notice == "The run could not be read. The report was kept. Retry or try setting it aside again.")
			await transport.refuseReads(false)
		}
		await screen.setAsideReport(shown)
		#expect(!screen.hasPendingReport(for: shown))
		#expect(!screen.canSetAsideReport(shown))
		#expect(!screen.canUndo)
		guard case .read(let fresh) = screen.document else { throw ClientError.unreadable }
		#expect(screen.mayRecord(fresh))
		#expect(screen.latestSlot(fresh).ownFill(by: Live.name)?.outcome == .manual(.blocked))
		#expect(screen.note == "Keep this observation")
		#expect(screen.failedStep == shown.content.steps.first?.id)
		#expect(try await results(client, shown).count == 2)
		#expect(await screen.record(fresh, outcome: .fail))
		#expect(try await results(client, fresh).count == 3)
		#expect(screen.slots.first { $0.id == fresh.slot.id }?.ownFill(by: Live.name)?.outcome == .manual(.fail))
	}

	@Test("a refresh overtaking Set report aside keeps the report without a false read failure", arguments: [false, true])
	func overtakenSetAsideRead(_ refreshFinishesFirst: Bool) async throws {
		let (screen, client, transport, execution) = try await setup()
		await transport.fail(.unreadable)
		#expect(await screen.record(execution, outcome: .fail) == false)
		await transport.fail(.refused, command: "none")
		await screen.retryReport()
		#expect(screen.canSetAsideReport(execution))
		let refusal = "The server refused this report's resend. Report refused.\nThe earlier attempt may still have been recorded. Retry the same report or set it aside for this slot."
		#expect(screen.notice == refusal)
		let older = await transport.holdNextRead()
		let newer = await transport.holdNextRead()
		let settingAside = Task { await screen.setAsideReport(execution) }
		await older.waitUntilAsked()
		let refreshing = Task { await screen.refresh() }
		await newer.waitUntilAsked()
		if refreshFinishesFirst {
			await newer.release()
			await refreshing.value
		}
		await older.release()
		await settingAside.value
		#expect(screen.hasPendingReport(for: execution))
		#expect(screen.canSetAsideReport(execution))
		#expect(screen.notice == refusal)
		if !refreshFinishesFirst {
			await newer.release()
			await refreshing.value
		}
		#expect(screen.hasPendingReport(for: execution))
		#expect(screen.notice == refusal)
		#expect(screen.latestSlot(execution).ownFill(by: Live.name)?.outcome == .manual(.fail))
		await screen.setAsideReport(execution)
		#expect(!screen.hasPendingReport(for: execution))
		#expect(screen.notice == "The report is set aside on this device. It may still have been recorded. The slot shows the latest results read from the server.")
		#expect(try await results(client, execution).count == 1)
	}

	@Test("an unproven resend refusal keeps the report uncertain", arguments: [
		ReportReplies.Fault.statuslessRefusal, .internalError, .unreadable
	])
	func unprovenResendRefusal(_ fault: ReportReplies.Fault) async throws {
		let (screen, client, transport, execution) = try await setup()
		await transport.fail(.unreadable)
		#expect(await screen.record(execution, outcome: .fail) == false)
		await transport.fail(fault, command: "none")
		await screen.retryReport()
		#expect(screen.hasPendingReport(for: execution))
		#expect(!screen.canSetAsideReport(execution))
		#expect(screen.notice?.hasPrefix("This report's outcome is unknown.") == true)
		await screen.setAsideReport(execution)
		#expect(screen.hasPendingReport(for: execution))
		await transport.reconnect()
		await screen.retryReport()
		#expect(!screen.hasPendingReport(for: execution))
		#expect(try await results(client, execution).count == 1)
	}

	@Test("lost Undo receipts then Undo recover one correction")
	func lostUndo() async throws {
		let (screen, client, transport, execution) = try await setup()
		#expect(await screen.record(execution, outcome: .pass))
		await transport.fail(.lost)
		await screen.undo()
		await transport.reconnect()
		await screen.undo()
		#expect(screen.canUndo == false)
		#expect(screen.slots.first { $0.id == execution.slot.id }?.ownFill(by: Live.name)?.outcome == .manual(.skip))
		#expect(try await results(client, execution).count == 2)
		#expect(Set(await transport.inputs.dropFirst().compactMap { $0["cmd"]?.string }).count == 1)
		#expect(await transport.lookups == 1)
	}

	@Test("recovering an older slot keeps Undo for a newer confirmed result", arguments: [false, true])
	func recoveryKeepsNewerUndo(_ pendingUndo: Bool) async throws {
		let (screen, _, transport, execution) = try await setup()
		if pendingUndo {
			#expect(await screen.record(execution, outcome: .pass))
			await transport.fail(.unreadable)
			await screen.undo()
		} else {
			await transport.fail(.unreadable)
			#expect(await screen.record(execution, outcome: .pass) == false)
		}
		await transport.reconnect()
		let next = try #require(screen.slots.first { $0.id != execution.slot.id && $0.fills.isEmpty })
		await screen.execute(next)
		guard case .read(let shown) = screen.document else { throw ClientError.unreadable }
		#expect(await screen.record(shown, outcome: .pass))
		await screen.retryReport()
		#expect(screen.canUndo)
		await screen.undo()
		#expect(screen.slots.first { $0.id == next.id }?.ownFill(by: Live.name)?.outcome == .manual(.skip))
		#expect(screen.slots.first { $0.id == execution.slot.id }?.ownFill(by: Live.name)?.outcome == .manual(pendingUndo ? .skip : .pass))
	}

	@Test("a refresh invalidates Undo after an external correction")
	func staleUndo() async throws {
		let (screen, client, transport, execution) = try await setup()
		#expect(await screen.record(execution, outcome: .pass))
		let saved = try #require(screen.slots.first { $0.id == execution.slot.id }?.ownFill(by: Live.name))
		let _: JSONValue = try await client.server.write("report", in: client.key, ["run": .string(execution.run),
			"results": [["test": ["case": .string(try #require(execution.slot.caseRef))], "outcome": "blocked", "corrects": .number(Double(saved.result))]]])
		await screen.refresh()
		#expect(screen.canUndo == false)
		let count = await transport.inputs.count
		await screen.undo()
		#expect(await transport.inputs.count == count)
	}

	@Test("a confirmed pass clears the submitted step mark without reporting a failed step")
	func passClearsMark() async throws {
		let (screen, _, _, execution) = try await setup()
		screen.mark(try #require(execution.content.steps.first))
		#expect(await screen.record(execution, outcome: .pass))
		let slot = try #require(screen.slots.first { $0.id == execution.slot.id })
		await screen.execute(slot)
		#expect(screen.failedStep == nil)
		#expect(slot.ownFill(by: Live.name)?.atStep == nil)
		#expect(slot.ownFill(by: Live.name)?.outcome == .manual(.pass))
	}

	@Test("open detail reads fresh fills without replacing its pinned document or draft")
	func latestFills() async throws {
		let (screen, client, _, execution) = try await setup()
		screen.note = "Draft kept while reading"
		let _: JSONValue = try await client.server.write("report", in: client.key, ["run": .string(execution.run),
			"results": [["test": ["case": .string(try #require(execution.slot.caseRef))], "outcome": "pass", "note": "Fresh fill"]]])
		await screen.refresh()
		#expect(screen.latestSlot(execution).fills.first?.note == "Fresh fill")
		#expect(screen.document == .read(execution))
		#expect(screen.note == "Draft kept while reading")
	}

	@Test("Undo preserves an absent note instead of adding withdrawal text")
	func absentNote() async throws {
		let (screen, _, _, execution) = try await setup()
		#expect(await screen.record(execution, outcome: .pass))
		await screen.execute(try #require(screen.slots.first { $0.id == execution.slot.id }))
		guard case .read(let shown) = screen.document else { throw ClientError.unreadable }
		#expect(await screen.record(shown, outcome: .blocked))
		await screen.undo()
		let fill = try #require(screen.slots.first { $0.id == execution.slot.id }?.ownFill(by: Live.name))
		#expect(fill.outcome == .manual(.pass) && fill.note == nil)
	}

	@Test("Undo restores the latest prior fill's note, step, trail and ordered screenshots", arguments: [false, true])
	func restoreLatestEvidence(_ reopen: Bool) async throws {
		let (screen, client, _, execution) = try await setup()
		let step = try #require(execution.content.steps.first?.id)
		let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
		let _: JSONValue = try await client.server.write("report", in: client.key, ["run": .string(execution.run), "results": [[
			"test": ["case": .string(try #require(execution.slot.caseRef))], "outcome": "fail", "note": " Latest failure ",
			"steps": [["step": .string(step), "outcome": "fail", "durationMs": 700, "attachment": 1,
				"actions": [["text": "Inspect total", "outcome": "fail", "durationMs": 650]]]],
			"attachments": [["name": "first.png", "data": .string(png)], ["name": "second.png", "data": .string(png), "at": .string(step)]],
		]]])
		await screen.refresh()
		let prior = try #require(screen.slots.first { $0.id == execution.slot.id }?.ownFill(by: Live.name))
		// One execution predates the external fill; the other opens after it.
		var shown = execution
		if reopen {
			await screen.execute(try #require(screen.slots.first { $0.id == execution.slot.id }))
			guard case .read(let fresh) = screen.document else { throw ClientError.unreadable }
			shown = fresh
		}
		#expect(await screen.record(shown, outcome: .pass))
		await screen.undo()
		let restored = try #require(screen.slots.first { $0.id == execution.slot.id }?.ownFill(by: Live.name))
		#expect(restored.outcome == .manual(.fail) && restored.note == " Latest failure ")
		#expect(restored.atStep == step && restored.steps == prior.steps)
		let screenshot = try await client.screenshot(result: restored.result, index: 1)
		#expect(screenshot.name == "second.png" && screenshot.data == Data(base64Encoded: png))
		let files: Wire.AttachmentList = try await client.server.read("attachment", in: client.key,
			["result": .number(Double(restored.result))])
		#expect(files.items.map(\.at) == [nil, step])
		#expect(try await client.screenshot(result: restored.result, index: 0).name == "first.png")
	}
}
