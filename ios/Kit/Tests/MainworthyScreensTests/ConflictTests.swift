import Foundation
import TestSupport
import Testing
@testable import MainworthyClient
@testable import MainworthyScreens

@Suite("Native case conflict resolution", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
@MainActor
struct NativeConflictTests {
	@Test("an overlapping save keeps a live resolver instead of ending the editor")
	func overlapRemainsResolvable() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		let ref = try #require(try await project.cases().items.first?.ref)
		let opened = try await project.caseDocument(ref)
		let editor = CaseEditorScreen(project: project, source: .edit(opened))
		editor.content.title = "My overlapping title"
		var other = opened.content
		other.title = "Current overlapping title"
		_ = try await project.saveCase(SuiteSubmission(source: .edit(opened), content: other, reason: "Other edit"))
		_ = await editor.save()
		#expect(!editor.settled)
		#expect(editor.notice?.contains("web app") != true)
		#expect(editor.content.title == "My overlapping title")
		let conflict = try #require(editor.conflict)
		#expect(conflict.addresses == [.field(.title)] && !editor.maySave)
		editor.chooseConflict(.field(.title), side: .mine)
		#expect(editor.maySave)
		guard case .adopted(let stamp) = await editor.save(), let stamp else {
			Issue.record("\(editor.notice ?? "merge did not adopt")"); return
		}
		#expect(stamp.version == 3 && editor.savedDocument?.content.title == "My overlapping title")
		#expect(try await project.caseDocument(ref).content.title == "My overlapping title")

	}
	@Test("a selected literal inline token is refused visibly and keeps the draft")
	func literalMergeNeedsWeb() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		let ref = try #require(try await project.cases().items.first?.ref)
		let opened = try await project.caseDocument(ref)
		let editor = CaseEditorScreen(project: project, source: .edit(opened))
		editor.content.title = "My literal #critical @REQ-899"
		var other = opened.content; other.title = "Current title"
		_ = try await project.saveCase(SuiteSubmission(source: .edit(opened), content: other, reason: "Other"))
		_ = await editor.save()
		editor.chooseConflict(.field(.title), side: .mine)
		_ = await editor.save()
		#expect(!editor.settled)
		#expect(editor.notice?.contains("use the web app") == true)
		#expect(editor.conflict?.merged.title == "My literal #critical @REQ-899")
		#expect(try await project.caseDocument(ref).content.title == "Current title")
	}

	@Test("keeping a current literal title leaves its version and text unchanged")
	func keepLiteralCurrent() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		let ref = try #require(try await project.cases().items.first?.ref)
		let opened = try await project.caseDocument(ref)
		let editor = CaseEditorScreen(project: project, source: .edit(opened))
		editor.content.title = "Mine"
		let literal = "Enter #critical in the filter @REQ-899"
		var other = opened.content; other.title = literal
		_ = try await project.saveCase(SuiteSubmission(source: .edit(opened), content: other, reason: "Other"))
		_ = await editor.save()
		editor.chooseConflict(.field(.title), side: .current)
		_ = await editor.save()
		#expect(editor.settled && editor.notice == "Conflict resolved. The recorded version already holds this text.")
		#expect(try await project.caseHistory(ref).map(\.version) == [2, 1])
		#expect(try await project.caseDocument(ref).content.title == literal)
	}

}

@Suite("Conflict choices")
struct ConflictChoiceTests {
	@Test("the shared web choice scenarios produce the same complete body in JavaScriptCore")
	func sharedChoices() throws {
		struct Scenario: Decodable {
			struct Choice: Decodable { let address: ConflictAddress; let side: String }
			let name: String
			let base: Wire.CaseBody
			let mine: Wire.CaseBody
			let current: Wire.CaseBody
			let choices: [Choice]
			let expected: Wire.CaseBody
			let addresses: [ConflictAddress]
		}
		let url = try #require(Bundle.module.url(forResource: "conflict-choices", withExtension: "json", subdirectory: "Fixtures"))
		let scenarios = try JSONDecoder().decode([Scenario].self, from: Data(contentsOf: url))
		for row in scenarios {
			var conflict = try CaseConflict(question: "Q-1", evidence: "read", ref: "C-1",
				base: CaseContent(row.base), mine: CaseContent(row.mine), current: CaseContent(row.current))
			#expect(conflict.addresses == row.addresses, "\(row.name)")
			for choice in row.choices { try conflict.choose(choice.address, side: choice.side == "mine" ? .mine : .current) }
			#expect(conflict.complete, "\(row.name)")
			#expect(conflict.merged == CaseContent(row.expected), "\(row.name)")
		}
	}

	@Test("a pin named order keeps the chosen current version")
	func pinNamedOrder() throws {
		let base = CaseContent(title: "Pin", steps: [Step(id: "order", action: "", expected: nil,
			use: .init(fragment: "C-1", version: 1))])
		var mine = base; mine.steps[0].use = .init(fragment: "C-1", version: 2)
		var current = base; current.steps[0].use = .init(fragment: "C-1", version: 3)
		var conflict = try CaseConflict(question: "Q-1", evidence: "read", ref: "C-2", base: base, mine: mine, current: current)
		#expect(conflict.addresses == [.step("order")])
		try conflict.choose(.step("order"), side: .current)
		#expect(conflict.complete && conflict.merged.steps[0].use == .init(fragment: "C-1", version: 3))
	}

	@Test("independent step parts, deletion and custom fields keep the whole document")
	func choices() throws {
		let base = CaseContent(title: "Base", steps: [
			Step(id: "a0", action: "Open", expected: "Ready"), Step(id: "a1", action: "Remove", expected: nil),
		], fields: ["priority": "high", "keep": "yes"])
		var mine = base
		mine.steps[0] = Step(id: "a0", action: "My action", expected: "My expectation")
		mine.steps.removeLast()
		mine.fields["priority"] = "low"
		var current = base
		current.steps[0] = Step(id: "a0", action: "Their action", expected: "Their expectation")
		current.steps[1].expected = "Their removal expectation"
		current.pre = "Concurrent precondition"
		current.fields["priority"] = "normal"
		var conflict = try CaseConflict(question: "Q-1", evidence: "read", ref: "C-1", base: base, mine: mine, current: current)
		#expect(Set(conflict.addresses) == [.stepField("a0", .action), .stepField("a0", .expected), .step("a1"), .customField("priority")])
		try conflict.choose(.stepField("a0", .action), side: .mine)
		try conflict.choose(.stepField("a0", .expected), side: .current)
		try conflict.choose(.step("a1"), side: .current)
		try conflict.choose(.customField("priority"), side: .mine)
		#expect(conflict.complete)
		#expect(conflict.merged == CaseContent(title: "Base", pre: "Concurrent precondition", steps: [
			Step(id: "a0", action: "My action", expected: "Their expectation"),
			Step(id: "a1", action: "Remove", expected: "Their removal expectation"),
		], fields: ["priority": "low", "keep": "yes"]))
		try conflict.choose(.step("a1"), side: .mine)
		#expect(conflict.merged.steps.map(\.id) == ["a0"])
	}

	@Test("keeping an edited step after deleting it restores its place between surviving steps")
	func restorePosition() throws {
		let steps = ["a0", "a1", "a2"].map { Step(id: $0, action: $0, expected: nil) }
		let base = CaseContent(title: "Base", steps: steps)
		var mine = base; mine.steps.remove(at: 1)
		var current = base; current.steps[1].expected = "Keep this expected result"
		var conflict = try CaseConflict(question: "Q-1", evidence: "read", ref: "C-1", base: base, mine: mine, current: current)
		try conflict.choose(.step("a1"), side: .current)
		#expect(conflict.merged.steps.map(\.id) == ["a0", "a1", "a2"])
		#expect(conflict.merged.steps[1].expected == "Keep this expected result")
	}

	@Test("an order conflict keeps a concurrent added step and the selected order")
	func order() throws {
		let steps = ["a0", "a1", "a2"].map { Step(id: $0, action: $0, expected: nil) }
		let base = CaseContent(title: "Base", steps: steps)
		var mine = base; mine.steps = [steps[1], steps[0], steps[2]]
		var current = base; current.steps = [steps[0], steps[2], steps[1], Step(id: "b0", action: "Added", expected: nil)]
		var conflict = try CaseConflict(question: "Q-1", evidence: "read", ref: "C-1", base: base, mine: mine, current: current)
		#expect(conflict.addresses == [.stepOrder])
		try conflict.choose(.stepOrder, side: .current)
		#expect(conflict.merged.steps.map(\.id) == ["a0", "a2", "a1", "b0"])
	}
}

@Suite("Conflict recovery", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
@MainActor
struct ConflictRecoveryTests {
	actor LosingReply: Transport {
		let live = URLSessionTransport()
		var losing = false
		var pausing = false
		var held: CheckedContinuation<Void, Never>?
		var waiting: CheckedContinuation<Void, Never>?
		var arrived = false
		func pause() { pausing = true }
		func waitForMerge() async {
			if arrived { return }
			await withCheckedContinuation { waiting = $0 }
		}
		func release() { pausing = false; held?.resume(); held = nil }
		private(set) var merges: [Data] = []
		private(set) var mergeReplies: [Data] = []
		private(set) var commands = 0
		func lose() { losing = true }
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			if request.url?.path.hasSuffix("/command") == true { commands += 1 }
			if pausing, request.url?.path.hasSuffix("/decide") == true {
				await withCheckedContinuation {
					held = $0; arrived = true; waiting?.resume(); waiting = nil
				}
			}
			let reply = try await live.send(request)
			if request.url?.path.hasSuffix("/decide") == true {
				merges.append(request.httpBody ?? Data())
				mergeReplies.append(reply.0)
				if losing { throw URLError(.networkConnectionLost) }
			}
			return reply
		}
		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			try await live.lines(request)
		}
	}

	private func setup(_ project: ProjectClient) async throws -> (CaseDocument, CaseEditorScreen) {
		let ref = try #require(try await project.cases().items.first?.ref)
		let opened = try await project.caseDocument(ref)
		let editor = CaseEditorScreen(project: project, source: .edit(opened))
		editor.content.title = "My title"
		var other = opened.content; other.title = "Their title"
		_ = try await project.saveCase(SuiteSubmission(source: .edit(opened), content: other, reason: "Other"))
		_ = await editor.save()
		#expect(editor.conflict?.addresses == [.field(.title)])
		editor.chooseConflict(.field(.title), side: .mine)
		return (opened, editor)
	}

	private func requireMergeReason(_ key: String) async throws {
		let owner = try await Live.signedIn(as: Live.owner)
		let policy: JSONValue = try await owner.read("admin", in: nil,
			["do": "policy.show", "project": .string(key)])
		let clauses = try #require(policy["clauses"]?.array).map { clause -> JSONValue in
			guard clause["id"]?.string == "adopt-conflict", var row = clause.object,
				var ask = clause["ask"]?.object else { return clause }
			ask["reason"] = "required"; row["ask"] = .object(ask)
			return .object(row)
		}
		let proposed: Wire.SuiteProposeReply = try await owner.read("propose", in: key,
			["edits": [["op": "policy", "base": try #require(policy["version"]), "clauses": .array(clauses)]]])
		let project = try await owner.project(key)
		let ref = try #require(proposed.question)
		let question = try #require(try await project.question(ref))
		let replies: JSONValue = try await owner.read("decide", in: key,
			["q": .string(question.ref), "onEvidence": .string(question.evidenceHash), "answer": ["is": "accept"]])
		#expect(replies.array?.first?["status"]?.string == "decided")
	}

	@Test("a merge paused in flight preserves another client's decision")
	func pausedMerge() async throws {
		let transport = LosingReply()
		let server = try await Live.signedIn(transport: transport)
		let key = try await Live.project()
		let project = try await server.project(key)
		let (opened, editor) = try await setup(project)
		let question = try #require(editor.conflict?.question)
		let colleague = try await Live.signedIn().project(key)
		let q = try #require(try await colleague.question(question))
		let reject = try #require(q.choices.first { $0.answer == "reject" })
		await transport.pause()
		defer { Task { await transport.release() } }
		let saving = Task { await editor.save() }
		await transport.waitForMerge()
		_ = try await colleague.answer(q, with: reject)
		let before = try #require(try await colleague.question(question)?.ifDecision)
		await transport.release()
		#expect(await saving.value == nil)
		let replies = await transport.mergeReplies
		let reply = try JSONDecoder().decode(JSONValue.self, from: #require(replies.first))
		#expect(reply["result"]?.array?.first?["status"]?.string == "conflict")
		#expect(reply["result"]?.array?.first?["needs"]?.string == "the question is no longer open; read it again before answering")
		let requests = await transport.merges
		let input = try JSONDecoder().decode(JSONValue.self, from: #require(requests.first))
		#expect(input["ifOpen"]?.bool == true)
		#expect(try await colleague.question(question)?.ifDecision == before)
		#expect(editor.conflictClosed && !editor.maySave)
		#expect(editor.notice?.contains("answered elsewhere") == true)
		#expect(editor.conflict?.merged.title == "My title" && editor.content.title == "My title")
		#expect(try await project.caseDocument(opened.ref).content.title == "Their title")
		#expect(try await project.caseHistory(opened.ref).map(\.version) == [2, 1])
	}

	@Test("a required conflict reason blocks an empty answer and records the typed reason on retry")
	func requiredReason() async throws {
		let transport = LosingReply()
		let server = try await Live.signedIn(transport: transport)
		let key = try await Live.project()
		try await requireMergeReason(key)
		let project = try await server.project(key)
		let (opened, editor) = try await setup(project)
		let question = try #require(editor.conflict?.question)
		#expect(try await project.question(question)?.wantsReason == true)
		#expect(!editor.maySave)
		#expect(await editor.save() == nil)
		#expect(await transport.merges.isEmpty)
		editor.reason = " \t\n\u{FEFF}"
		#expect(!editor.maySave)
		editor.reason = String(repeating: "r", count: 501)
		#expect(!editor.maySave)
		editor.reason = "I kept my title after reading both edits"
		#expect(editor.maySave)
		await transport.lose()
		#expect(await editor.save() == nil)
		#expect(editor.isRetrying)
		let merges = await transport.merges
		let sent = try JSONDecoder().decode(JSONValue.self, from: #require(merges.first))
		#expect(sent["reason"]?.string == "I kept my title after reading both edits")
		#expect(sent["ifOpen"]?.bool == true)
		#expect(try #require(sent["cmd"]?.string).isEmpty == false)
		#expect(try merges.allSatisfy { try JSONDecoder().decode(JSONValue.self, from: $0) == sent })
		for data in await transport.mergeReplies {
			let reply = try JSONDecoder().decode(JSONValue.self, from: data)
			#expect(reply["result"]?.array?.first?["status"]?.string == "decided")
		}
		editor.reason = ""
		#expect(editor.maySave)
		guard case .adopted(let stamp) = await editor.save(), let stamp else {
			Issue.record("\(editor.notice ?? "reasoned merge did not recover")"); return
		}
		#expect(stamp.version == 3 && editor.savedDocument?.content.title == "My title")
		let decided = try #require(try await project.question(question)?.decision)
		#expect(decided.reason == "I kept my title after reading both edits")
		#expect(await transport.commands == 1)
		#expect(await transport.merges.count == merges.count)
		#expect(try await project.caseHistory(opened.ref).map(\.version) == [3, 2, 1])
	}

	@Test("a lost merge reply is recovered by command with no further merge writes")
	func lost() async throws {
		let transport = LosingReply()
		let server = Server(instance: Live.instance, secrets: MemoryStore(), transport: transport)
		_ = try await server.signIn(.password(name: Live.name, password: Live.password))
		let project = try await server.project(try await Live.project())
		let (opened, editor) = try await setup(project)
		await transport.lose()
		#expect(await editor.save() == nil)
		#expect(editor.isRetrying && editor.content.title == "My title")
		editor.chooseConflict(.field(.title), side: .current)
		#expect(editor.conflict?.merged.title == "My title")
		let count = await transport.merges.count
		guard case .adopted(let stamp) = await editor.save(), let stamp else { Issue.record("\(editor.notice ?? "not recovered")"); return }
		#expect(stamp.version == 3 && editor.savedDocument?.content.title == "My title")
		#expect(await transport.commands == 1)
		#expect(await transport.merges.count == count)
		#expect(try await project.caseHistory(opened.ref).map(\.version) == [3, 2, 1])
	}

	@Test("a moved case opens a replacement conflict and keeps the selected merge")
	func moved() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		let (opened, editor) = try await setup(project)
		let first = try #require(editor.conflict?.question)
		let now = try await project.caseDocument(opened.ref)
		var next = now.content; next.title = "A third title"; next.pre = "Concurrent precondition"
		_ = try await project.saveCase(SuiteSubmission(source: .edit(now), content: next, reason: "Moved"))
		#expect(await editor.save() == nil)
		let replacement = try #require(editor.conflict)
		#expect(replacement.question != first && replacement.mine.title == "My title")
		#expect(replacement.current.title == "A third title" && !replacement.complete)
		editor.chooseConflict(.field(.title), side: .mine)
		_ = await editor.save()
		#expect(editor.savedDocument?.content.title == "My title")
		#expect(editor.savedDocument?.content.pre == "Concurrent precondition")
	}

	@Test("keeping current resolves without inventing a new version")
	func unchanged() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		let (opened, editor) = try await setup(project)
		editor.chooseConflict(.field(.title), side: .current)
		_ = await editor.save()
		#expect(editor.settled && editor.notice == "Conflict resolved. The recorded version already holds this text.")
		#expect(try await project.caseHistory(opened.ref).map(\.version) == [2, 1])
		#expect(editor.content.title == "My title")
	}

	@Test("the exact historical base keeps custom fields across default and partial case reads", arguments: [false, true])
	func customFields(partial: Bool) async throws {
		let server = try await Live.signedIn()
		let project = try await server.project(try await Live.project())
		let made = try await project.saveCase(SuiteSubmission(source: .create(folder: nil),
			content: CaseContent(title: "Base", fields: ["priority": "high"]), reason: "Create"))
		guard case .adopted(let stamp) = made, let stamp else { Issue.record("not created"); return }
		let opened: CaseDocument
		if partial {
			let rows: [Wire.SuiteDocument] = try await server.read("get", in: project.key, [
				"refs": [.string(stamp.ref)],
				"fields": ["title", "pre", "steps", "methods", "tags", "place", "proof"],
			])
			opened = CaseDocument(try #require(rows.first))
		} else {
			opened = try await project.caseDocument(stamp.ref, includingCustomFields: false)
		}
		#expect(opened.readFields == (partial ? nil : ["priority": "high"]))
		let editor = CaseEditorScreen(project: project, source: .edit(opened))
		editor.content.title = "My custom case"
		let _: Wire.SuiteProposeReply = try await server.read("propose", in: project.key, ["edits": [[
			"op": "edit", "case": .string(stamp.ref), "base": 1,
			"body": ["title": "Their custom case", "fields": ["priority": "normal"]],
		]]])
		_ = await editor.save()
		#expect(editor.conflict?.addresses == [.field(.title)])
		#expect(editor.conflict?.merged.fields == ["priority": "normal"])
		editor.chooseConflict(.field(.title), side: .mine)
		_ = await editor.save()
		#expect(editor.savedDocument?.content.title == "My custom case")
		let fields: Wire.ConflictBaseFields = try await server.read("history", in: project.key,
			["ref": .string(stamp.ref), "from": 3, "to": 3])
		#expect(fields.diff.fields.before == ["priority": "normal"])
	}

	@Test("a question answered elsewhere refuses the merge and retains the draft and choices")
	func refused() async throws {
		let project = try await Live.signedIn().project(try await Live.project())
		let (opened, editor) = try await setup(project)
		let question = try #require(editor.conflict?.question)
		let q = try #require(try await project.question(question))
		let choice = try #require(q.choices.first { $0.answer == "reject" })
		_ = try await project.answer(q, with: choice)
		#expect(await editor.save() == nil)
		#expect(!editor.settled && editor.content.title == "My title" && editor.conflict?.merged.title == "My title")
		#expect(editor.conflict?.complete == true)
		#expect(editor.notice?.contains("answered elsewhere") == true)
		#expect(editor.notice?.contains("Cancel") == true)
		#expect(!editor.maySave)
		#expect(await editor.save() == nil)
		#expect(try await project.caseHistory(opened.ref).map(\.version) == [2, 1])
		#expect(try await project.caseDocument(opened.ref).content.title == "Their title")
	}
}
