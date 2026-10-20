import Foundation
import TestSupport
import Testing

@testable import MainworthyClient
@testable import MainworthyScreens

actor ReportReplies: Transport {
	enum Fault: Sendable { case lost, unreadable, internalError, refused, lostThenRefused }
	var fault: Fault?
	var commandState: String?
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
		if op == "command" {
			lookups += 1
			if let commandState { return reply(#"{"ok":true,"result":{"state":"\#(commandState)"}}"#) }
		}
		if op == "report" {
			inputs.append(input)
			if fault == .refused || (fault == .lostThenRefused && inputs.count > 1) {
				return reply(#"{"ok":false,"error":{"code":"conflict","message":"Report refused."}}"#, 409)
			}
		}
		let response = try await URLSessionTransport().send(request)
		if op == "report", let fault {
			switch fault {
			case .lost, .lostThenRefused: throw URLError(.networkConnectionLost)
			case .unreadable: return reply("unreadable receipt")
			case .internalError: return reply(#"{"ok":false,"error":{"code":"internal","message":"Receipt unavailable."}}"#, 500)
			case .refused: break
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
