import Foundation
import Testing
@testable import MainworthyClient
@testable import MainworthyScreens
import TestSupport

@Suite("Following case proposals", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
@MainActor
struct CaseProposalFollowTests {
	actor Reads: Transport {
		let real = URLSessionTransport()
		var failing = false
		private(set) var proposals = 0
		func fail(_ value: Bool) { failing = value }
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			if request.url?.path.hasSuffix("/propose") == true { proposals += 1 }
			if failing, request.url?.path.hasSuffix("/get") == true,
				let input = try? JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data()),
				input["refs"]?.array?.first?.string?.hasPrefix("Q-") == true {
				throw URLError(.notConnectedToInternet)
			}
			return try await real.send(request)
		}
		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			try await real.lines(request)
		}
	}

	private func decide(_ key: String, question ref: String, answer: String, body: CaseContent? = nil) async throws -> CaseStamp? {
		let owner = try await Live.signedIn(as: Live.owner)
		let project = try await owner.project(key)
		let question = try #require(try await project.question(ref))
		var choice: JSONValue = ["is": .string(answer)]
		if let body { choice = ["is": .string(answer), "body": body.json] }
		let reply: [JSONValue] = try await owner.write("decide", in: key, [
			"q": .string(ref), "onEvidence": .string(question.evidenceHash),
			"answer": choice, "reason": "Reviewed this case",
		])
		#expect(reply.first?["status"]?.string == "decided")
		guard let saved = reply.first?["effects"]?["cases"]?.array?.first,
			let ref = saved["ref"]?.string, let version = saved["version"]?.number else { return nil }
		return CaseStamp(ref: ref, version: Int(version))
	}

	@Test("refresh follows an accepted create and a later edit versions the same case")
	func accepted() async throws {
		let key = try await Live.project(strict: true)
		let client = try await Live.signedIn().project(key)
		let screen = SuiteScreen(project: client)
		screen.newCase()
		let editor = try #require(screen.editor)
		editor.content.title = "Continue the accepted case"
		editor.content.pre = "Keep my submitted precondition"
		guard case .waiting(let question, _) = await editor.save(), let question else {
			Issue.record("strict create did not wait"); return
		}
		#expect(editor.locked && editor.isRetrying && !editor.settled)
		let stamp = try #require(try await decide(key, question: question, answer: "accept"))
		await screen.refresh()
		#expect(screen.editor === editor && !editor.locked)
		guard case .edit(let followed) = editor.source else { Issue.record("editor did not follow the accepted case"); return }
		#expect(followed.ref == stamp.ref && followed.version == 1)
		#expect(editor.content.title == "Continue the accepted case" && editor.content.pre == "Keep my submitted precondition")
		editor.content.title = "Continue with version two"
		guard case .waiting(let next, _) = await editor.save(), let next else {
			Issue.record("strict edit did not wait"); return
		}
		let edited = try #require(try await decide(key, question: next, answer: "accept"))
		#expect(edited == CaseStamp(ref: stamp.ref, version: 2))
		await screen.refresh()
		#expect(try await client.caseHistory(stamp.ref).map(\.version) == [2, 1])
		#expect(try await client.cases(text: "Continue").items.map(\.ref) == [stamp.ref])
		#expect(try await client.cases().items.count == 2)
	}

	private func otherEdit(_ key: String, opened: CaseDocument, body: JSONValue) async throws {
		let owner = try await Live.signedIn(as: Live.owner)
		let reply: Wire.SuiteProposeReply = try await owner.read("propose", in: key, ["edits": [[
			"op": "edit", "case": .string(opened.ref), "base": .number(Double(opened.version)), "body": body,
		]]])
		let question = try #require(reply.question)
		#expect(try await decide(key, question: question, answer: "accept") == CaseStamp(ref: opened.ref, version: 2))
	}

	@Test("unchanged custom fields do not claim another person's changes", arguments: [false, true])
	func unchangedFields(throughScreen: Bool) async throws {
		let key = try await Live.project(strict: true)
		let client = try await Live.signedIn().project(key)
		let ref = try #require(try await client.cases().items.first?.ref)
		try await otherEdit(key, opened: client.caseDocument(ref), body: ["fields": ["priority": "high"]])
		let screen = SuiteScreen(project: client)
		let opened: CaseDocument
		if throughScreen {
			await screen.openCase(ref)
			guard case .read(let document) = screen.document(ref) else { Issue.record("case did not open"); return }
			opened = document
		} else { opened = try await client.caseDocument(ref) }
		await screen.edit(opened)
		let editor = try #require(screen.editor)
		#expect(editor.content.fields == ["priority": "high"])
		editor.content.title = "Only my title changes"
		guard case .waiting(let question, _) = await editor.save(), let question else { Issue.record("did not wait"); return }
		#expect(try await decide(key, question: question, answer: "accept") == CaseStamp(ref: ref, version: 3))
		await screen.refresh()
		#expect(!editor.locked && !editor.dirty)
		#expect(editor.content.title == "Only my title changes" && editor.content.fields == ["priority": "high"])
		#expect(editor.notice == "Proposal accepted. Continue editing \(ref), version 3.")
		editor.content.title = "My next title keeps the field"
		guard case .waiting(let next, _) = await editor.save(), let next else { Issue.record("next edit did not wait"); return }
		#expect(try await decide(key, question: next, answer: "accept") == CaseStamp(ref: ref, version: 4))
		let saved = try await client.caseDocument(ref)
		#expect(saved.content.title == "My next title keeps the field" && saved.content.fields == ["priority": "high"])
	}

	@Test("a configured custom field does not invent another person's changes on create")
	func createWithFieldDefinition() async throws {
		let key = try await Live.project(strict: true)
		let owner = try await Live.signedIn(as: Live.owner)
		let policy: JSONValue = try await owner.read("admin", in: nil, ["do": "policy.show", "project": .string(key)])
		var settings = try #require(policy["settings"]?.object)
		settings["fields"] = ["priority": [
			"kind": "choice", "label": "Priority", "required": false, "choices": ["low", "high"], "default": "high",
		]]
		let proposed: Wire.SuiteProposeReply = try await owner.write("propose", in: key, ["edits": [[
			"op": "policy", "base": try #require(policy["version"]), "settings": .object(settings),
		]]])
		_ = try await decide(key, question: #require(proposed.question), answer: "accept")
		let configured: JSONValue = try await owner.read("admin", in: nil, ["do": "policy.show", "project": .string(key)])
		#expect(configured["settings"]?["fields"]?["priority"] == [
			"kind": "choice", "label": "Priority", "required": false, "choices": ["low", "high"],
		])
		let client = try await Live.signedIn().project(key)
		let screen = SuiteScreen(project: client)
		screen.newCase()
		let editor = try #require(screen.editor)
		editor.content.title = "Create with a configured field"
		guard case .waiting(let question, _) = await editor.save(), let question else { Issue.record("did not wait"); return }
		let stamp = try #require(try await decide(key, question: question, answer: "accept"))
		await screen.refresh()
		#expect(!editor.locked && !editor.dirty)
		#expect(editor.notice == "Proposal accepted. Continue editing \(stamp.ref), version 1.")
		let saved = try await client.caseDocument(stamp.ref)
		#expect(saved.content.title == "Create with a configured field" && saved.content.fields == [:])
		#expect(editor.content == saved.content)
	}

	@Test("following a merged edit preserves recorded methods, automation and custom fields on the next save")
	func mergedMethods() async throws {
		let key = try await Live.project(strict: true)
		let client = try await Live.signedIn().project(key)
		let ref = try #require(try await client.cases().items.first?.ref)
		let opened = try await client.caseDocument(ref)
		let screen = SuiteScreen(project: client)
		await screen.edit(opened)
		let editor = try #require(screen.editor)
		#expect(editor.content.methods == ["human"] && editor.content.automate == "none")
		editor.content.title = "My proposed title"
		guard case .waiting(let question, _) = await editor.save(), let question else { Issue.record("did not wait"); return }
		try await otherEdit(key, opened: opened, body: [
			"methods": ["human", "agent"], "automate": "wanted", "fields": ["priority": "high"],
		])
		#expect(try await decide(key, question: question, answer: "accept") == CaseStamp(ref: ref, version: 3))
		await screen.refresh()
		#expect(!editor.locked && !editor.dirty)
		#expect(editor.content.title == "My proposed title")
		#expect(editor.content.methods == ["human", "agent"])
		#expect(editor.content.automate == "wanted")
		#expect(editor.content.fields == ["priority": "high"])
		#expect(editor.notice == "Proposal accepted. Continue editing \(ref), version 3. The saved case includes changes you did not make. Read it before editing again.")
		guard case .edit(let followed) = editor.source else { Issue.record("did not follow merged edit"); return }
		#expect(followed.version == 3 && followed.content == editor.content)
		editor.content.title = "My next title"
		guard case .waiting(let next, _) = await editor.save(), let next else { Issue.record("next edit did not wait"); return }
		#expect(try await decide(key, question: next, answer: "accept") == CaseStamp(ref: ref, version: 4))
		let saved = try await client.caseDocument(ref)
		#expect(saved.content.title == "My next title")
		#expect(saved.content.methods == ["human", "agent"] && saved.content.automate == "wanted")
		#expect(saved.content.fields == ["priority": "high"])
		#expect(try await client.caseHistory(ref).map(\.version) == [4, 3, 2, 1])
		#expect(try await client.cases().items.map(\.ref) == [ref])
	}

	@Test("following a merged precondition unlocks on the recorded text even after head advances")
	func mergedPreconditions() async throws {
		let key = try await Live.project(strict: true)
		let client = try await Live.signedIn().project(key)
		let ref = try #require(try await client.cases().items.first?.ref)
		let opened = try await client.caseDocument(ref)
		let screen = SuiteScreen(project: client)
		await screen.edit(opened)
		let editor = try #require(screen.editor)
		editor.content.title = "My title with their precondition"
		guard case .waiting(let question, _) = await editor.save(), let question else { Issue.record("did not wait"); return }
		try await otherEdit(key, opened: opened, body: ["pre": "Their accepted precondition"])
		#expect(try await decide(key, question: question, answer: "accept") == CaseStamp(ref: ref, version: 3))
		let current = try await client.caseDocument(ref)
		var later = current.content; later.pre = "A still newer precondition"
		guard case .waiting(let newest, _) = try await client.saveCase(SuiteSubmission(source: .edit(current), content: later, reason: "Later")),
			let newest else { Issue.record("later edit did not wait"); return }
		#expect(try await decide(key, question: newest, answer: "accept") == CaseStamp(ref: ref, version: 4))
		await screen.saveEditor()
		#expect(!editor.locked && !editor.isWaiting && !editor.isRetrying && !editor.dirty && editor.maySave)
		#expect(editor.content.title == "My title with their precondition")
		#expect(editor.content.pre == "Their accepted precondition")
		guard case .edit(let followed) = editor.source else { Issue.record("did not follow recorded version"); return }
		#expect(followed.ref == ref && followed.version == 3 && followed.content == editor.content)
		#expect(editor.notice?.contains("includes changes you did not make. Read it before editing again.") == true)
		#expect(try await client.caseHistory(ref).map(\.version) == [4, 3, 2, 1])
	}

	@Test("a merge answer reads the exact version recorded by its decision")
	func mergedAnswer() async throws {
		let key = try await Live.project()
		let client = try await Live.signedIn().project(key)
		let ref = try #require(try await client.cases().items.first?.ref)
		let opened = try await client.caseDocument(ref)
		var other = opened.content; other.title = "Their overlapping title"
		#expect(try await client.saveCase(SuiteSubmission(source: .edit(opened), content: other, reason: "Other edit")) == .adopted(CaseStamp(ref: ref, version: 2)))
		var mine = opened.content; mine.title = "My overlapping title"
		guard case .overlap(let question, _, _) = try await client.saveCase(SuiteSubmission(source: .edit(opened), content: mine, reason: "My edit")),
			let question else { Issue.record("did not create a conflict"); return }
		var merged = opened.content
		merged.title = "The reviewed merge title"
		merged.pre = "The reviewed merge precondition"
		merged.methods = ["human", "agent"]
		merged.automate = "wanted"
		merged.fields = ["priority": "normal"]
		let stamp = CaseStamp(ref: ref, version: 3)
		#expect(try await decide(key, question: question, answer: "merge", body: merged) == stamp)
		#expect(try await client.caseProposal(question) == .adopted(stamp))
		let recorded = try await client.caseDocument(ref, version: 3)
		#expect(recorded.content.title == "The reviewed merge title" && recorded.content.pre == "The reviewed merge precondition")
		#expect(recorded.content.methods == ["human", "agent"] && recorded.content.automate == "wanted")
	}

	@Test("a rejected proposal keeps the editable draft and its reason")
	func rejected() async throws {
		let key = try await Live.project(strict: true)
		let client = try await Live.signedIn().project(key)
		let screen = SuiteScreen(project: client)
		screen.newCase()
		let editor = try #require(screen.editor)
		editor.content.title = "Keep the rejected draft"
		editor.reason = "Keep my reason"
		let typed = editor.content
		guard case .waiting(let question, _) = await editor.save(), let question else { Issue.record("did not wait"); return }
		_ = try await decide(key, question: question, answer: "reject")
		await screen.refresh()
		#expect(screen.editor === editor && editor.content == typed && editor.reason == "Keep my reason")
		#expect(!editor.locked && !editor.settled && editor.maySave)
		#expect(editor.notice == "The proposal was rejected. Your draft is kept here.")
		#expect(try await client.cases(text: typed.title).items.isEmpty)
	}

	@Test("a failed question read keeps waiting and Retry follows without another create")
	func failedRead() async throws {
		let key = try await Live.project(strict: true)
		let transport = Reads()
		let client = try await Live.signedIn(transport: transport).project(key)
		let screen = SuiteScreen(project: client)
		screen.newCase()
		let editor = try #require(screen.editor)
		editor.content.title = "Follow after reconnection"
		guard case .waiting(let question, _) = await editor.save(), let question else { Issue.record("did not wait"); return }
		await screen.saveEditor()
		#expect(editor.isWaiting && editor.locked && !editor.settled)
		#expect(await transport.proposals == 1)
		let stamp = try #require(try await decide(key, question: question, answer: "accept"))
		await transport.fail(true)
		await screen.refresh()
		#expect(editor.locked && editor.isRetrying && editor.maySave && !editor.settled)
		#expect(editor.content.title == "Follow after reconnection")
		#expect(editor.notice?.contains("Still waiting to read the proposal's outcome.") == true)
		await transport.fail(false)
		await screen.saveEditor()
		guard case .edit(let followed) = editor.source else { Issue.record("Retry did not follow"); return }
		#expect(followed.ref == stamp.ref && followed.version == 1 && !editor.locked)
		#expect(await transport.proposals == 1)
		#expect(screen.editor === editor)
	}
}
