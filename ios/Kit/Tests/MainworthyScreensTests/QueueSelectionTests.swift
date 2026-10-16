import Foundation
import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

/// Several questions of one kind take one answer (decision 0088).
@Suite("Answering a selection", .enabled(if: Live.isRunning, "needs the server `bun scripts/ios.ts test` starts"))
@MainActor
struct QueueSelectionTests {
	/// A project with three more tests that have no case, each in its own file and so each its own question.
	func project() async throws -> String {
		let key = try await Live.project()
		let owner = Live.server()
		_ = try await owner.signIn(Live.owner)
		let _: JSONValue = try await owner.write("report", in: key, [
			"target": ["commit": .string(String(repeating: "5", count: 40)), "repo": "acme/shop", "branch": "main"],
			"job": "more",
			"results": .array(["search", "wishlist", "returns"].map { file in
				["test": ["key": .string("tests/\(file).spec.ts::\(file)"), "name": .string("The \(file) page opens"),
					"file": .string("tests/\(file).spec.ts")], "outcome": "pass"]
			}),
		])
		return key
	}

	func screen(_ key: String, transport: any Transport = URLSessionTransport()) async throws -> QueueScreen {
		let screen = QueueScreen(project: try await Live.signedIn(transport: transport).project(key))
		await screen.show(.open, filter: nil)
		return screen
	}

	@Test("a selection holds one kind, of questions this person can settle without opening them")
	func oneKind() async throws {
		let screen = try await screen(try await project())
		let unlinked = screen.questions.filter { $0.kind == .map }
		#expect(unlinked.count == 4)
		let proposal = try #require(screen.questions.first { $0.kind == .adopt })
		let finding = try #require(screen.questions.first { $0.kind == .finding })
		let failure = try #require(screen.questions.first { $0.kind == .failure })
		screen.select(true)
		screen.toggle(proposal)
		#expect(screen.selected.isEmpty && screen.notice?.text.contains("its edits are read on its page") == true)
		screen.toggle(finding)
		#expect(screen.selected.isEmpty && screen.notice?.text.contains("its suggested edit") == true)
		screen.toggle(unlinked[0])
		screen.toggle(failure)
		#expect(screen.selected == [unlinked[0].ref])
		#expect(screen.notice?.text == "\(failure.ref) is a failure and the selection is of unlinked: one answer is for one kind.")
		#expect(screen.selectable.map(\.ref) == unlinked.map(\.ref))
		screen.selectAll()
		#expect(screen.selected == unlinked.map(\.ref))
		// Linking needs a case for each test, on the question's own page.
		#expect(screen.sharedChoices.map(\.answer).sorted() == ["create", "track"])
		#expect(QueueScreen.tests(in: screen.selection) == 4)
		screen.toggle(unlinked[1])
		#expect(screen.selected.count == 3 && !screen.selected.contains(unlinked[1].ref))
		// Another filter or the decided list is another selection.
		await screen.show(.open, filter: .map)
		#expect(screen.selected.isEmpty && screen.isSelecting)
		screen.toggle(unlinked[0])
		screen.select(false)
		#expect(screen.selected.isEmpty && !screen.isSelecting)
	}

	@Test("one answer decides each selected question on its own, and Undo withdraws them together")
	func answerAndUndo() async throws {
		let transport = SwitchableQueueTransport()
		let screen = try await screen(try await project(), transport: transport)
		let unlinked = screen.questions.filter { $0.kind == .map }
		screen.select(true)
		for question in unlinked.prefix(3) { screen.toggle(question) }
		let track = try #require(screen.sharedChoices.first { $0.answer == "track" })
		transport.commands.withLock { $0 = [] }
		#expect(await screen.answerAll(screen.selection, with: track))
		let sent = try transport.commands.withLock { try $0.map { try JSONDecoder().decode(JSONValue.self, from: $0) } }
		// Each on its own evidence, with its own command, refused if somebody decided it meanwhile.
		#expect(sent.map { $0["q"]?.string } == unlinked.prefix(3).map(\.ref))
		#expect(sent.map { $0["onEvidence"]?.string } == unlinked.prefix(3).map { Optional($0.evidenceHash) })
		#expect(Set(sent.compactMap { $0["cmd"]?.string }).count == 3 && sent.allSatisfy { $0["ifOpen"] == true })
		#expect(screen.notice?.text == "3 unlinked: Track without a case." && screen.notice?.isProblem == false)
		#expect(screen.notice?.undoesAll.map(\.ref) == unlinked.prefix(3).map(\.ref))
		#expect(screen.selected.isEmpty && screen.isSelecting)
		#expect(screen.questions.filter { $0.kind == .map }.map(\.ref) == [unlinked[3].ref])
		#expect(screen.outbox.entries.suffix(3).map(\.status) == ["Recorded", "Recorded", "Recorded"])
		#expect(await screen.withdrawAll(try #require(screen.notice?.undoesAll)))
		#expect(screen.notice?.text == "3 decisions are withdrawn.")
		#expect(screen.questions.filter { $0.kind == .map }.count == 4)
	}

	@Test("a question decided elsewhere meanwhile is named, and the others are decided")
	func overtaken() async throws {
		let key = try await project()
		let screen = try await screen(key)
		let unlinked = screen.questions.filter { $0.kind == .map }
		screen.select(true)
		screen.toggle(unlinked[0])
		screen.toggle(unlinked[1])
		let elsewhere = try await Live.signedIn().project(key)
		let first = unlinked[0]
		#expect(try await elsewhere.answer(first, with: try #require(first.choices.first { $0.answer == "track" })).isDecided)
		let track = try #require(screen.sharedChoices.first { $0.answer == "track" })
		#expect(await screen.answerAll(screen.selection, with: track))
		let text = try #require(screen.notice?.text)
		#expect(text.hasPrefix("1 unlinked: Track without a case. Not recorded, read it again: \(first.ref): "))
		#expect(screen.notice?.isProblem == true && screen.notice?.undoesAll.map(\.ref) == [unlinked[1].ref])
	}

	@Test("an answer goes on the evidence shown when it was chosen, never on evidence read behind its dialog")
	func shownEvidence() async throws {
		let key = try await project()
		let transport = SwitchableQueueTransport()
		let screen = try await screen(key, transport: transport)
		let shipping = try #require(screen.questions.first { $0.title.contains("tests/shipping.spec.ts") })
		screen.select(true)
		screen.toggle(shipping)
		// What the confirmation holds: the questions as they were when the answer was chosen.
		let chosen = screen.selection
		let create = try #require(screen.sharedChoices.first { $0.answer == "create" })
		let owner = Live.server()
		_ = try await owner.signIn(Live.owner)
		let _: JSONValue = try await owner.write("report", in: key, [
			"target": ["commit": .string(String(repeating: "3", count: 40)), "repo": "acme/shop", "pr": 482],
			"job": "later", "results": [["test": ["key": "tests/shipping.spec.ts::shipping::unseen", "name": "A test nobody saw",
				"file": "tests/shipping.spec.ts"], "outcome": "pass"]],
		])
		// The change stream reads the list again while the dialog covers it.
		await screen.refresh()
		#expect(screen.selection.first?.evidenceHash != shipping.evidenceHash)
		transport.commands.withLock { $0 = [] }
		#expect(await screen.answerAll(chosen, with: create) == false)
		let sent = try transport.commands.withLock { try $0.map { try JSONDecoder().decode(JSONValue.self, from: $0) } }
		#expect(sent.map { $0["onEvidence"]?.string } == [shipping.evidenceHash])
		#expect(screen.notice?.isProblem == true && screen.notice?.text.contains("Not recorded, read it again: \(shipping.ref)") == true)
		let unseen: JSONValue = try await owner.read("find", in: key, ["in": "tests", "text": "A test nobody saw"])
		#expect(unseen["items"]?.array?.first?["case"] == .null)
	}

	@Test("answers given offline wait on the device, and nothing is claimed as decided")
	func offline() async throws {
		let transport = SwitchableQueueTransport()
		let screen = try await screen(try await project(), transport: transport)
		let unlinked = screen.questions.filter { $0.kind == .map }
		screen.select(true)
		screen.toggle(unlinked[0])
		screen.toggle(unlinked[1])
		let track = try #require(screen.sharedChoices.first { $0.answer == "track" })
		transport.offline.withLock { $0 = true }
		#expect(await screen.answerAll(screen.selection, with: track) == false)
		#expect(screen.notice?.text.hasPrefix("2 saved on this device, waiting to send.") == true)
		#expect(screen.notice?.undoesAll.isEmpty == true && screen.outbox.pendingCount == 2)
		// A question with an answer waiting cannot be selected again.
		screen.toggle(unlinked[0])
		#expect(screen.selected.isEmpty && screen.notice?.text == "\(unlinked[0].ref) has an answer waiting to send.")
		transport.offline.withLock { $0 = false }
		await screen.refresh()
		#expect(screen.outbox.pendingCount == 0 && screen.questions.filter { $0.kind == .map }.count == 2)
	}

	@Test("a reason the policy asks for is asked before anything is sent")
	func reason() async throws {
		let screen = try await screen(try await project())
		let failure = try #require(screen.questions.first { $0.kind == .failure })
		screen.select(true)
		screen.toggle(failure)
		let flaky = try #require(screen.sharedChoices.first { $0.answer == "flaky" })
		guard failure.wantsReason else {
			#expect(await screen.answerAll(screen.selection, with: flaky))
			return
		}
		#expect(await screen.answerAll(screen.selection, with: flaky) == false)
		#expect(screen.notice?.text == "Nothing was recorded: the policy asks for a reason.")
	}
}
