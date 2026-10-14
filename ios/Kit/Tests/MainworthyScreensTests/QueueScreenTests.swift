import Foundation
import MainworthyClient
import TestSupport
import Testing

@testable import MainworthyScreens

@Suite("The queue screen", .enabled(if: Live.isRunning, "needs the server `bun scripts/ios.ts test` starts"))
@MainActor
struct QueueScreenTests {
	func screen(strict: Bool = false) async throws -> QueueScreen {
		let screen = QueueScreen(project: try await Live.signedIn().project(try await Live.project(strict: strict)))
		await screen.show(.open, filter: nil)
		return screen
	}

	@Test("it shows what is open, the failure first, and says how much needs an answer")
	func lists() async throws {
		let screen = try await screen()
		#expect(screen.loading == .done)
		#expect(screen.questions.map(\.kind) == [.failure, .adopt, .finding, .map])
		#expect(screen.counts.phrase == "1 failure to explain · 3 can wait")
		#expect(!screen.hasMore)
	}

	@Test("an answer leaves the list, the screen says what was recorded, and Undo asks the question again")
	func answerAndUndo() async throws {
		let screen = try await screen()
		let failure = try #require(screen.questions.first)
		let flaky = try #require(failure.choices.first { $0.answer == "flaky" })
		#expect(await screen.answer(failure, with: flaky))
		#expect(screen.current(failure.ref) == nil)
		#expect(screen.counts.open == 3)
		#expect(screen.notice?.text == "\(failure.ref): Flaky.")
		#expect(screen.notice?.isProblem == false)
		let undoes = try #require(screen.notice?.undoes)
		await screen.withdraw(undoes)
		#expect(screen.current(failure.ref) != nil)
		#expect(screen.notice == .init(text: "\(failure.ref): the decision is withdrawn.", isProblem: false, undoes: nil))
		#expect(screen.busy.isEmpty)
	}

	@Test("the decided list shows who decided, and a filter shows one kind")
	func decidedAndFilter() async throws {
		let screen = try await screen()
		let finding = try #require(screen.questions.first { $0.kind == .finding })
		#expect(await screen.answer(finding, with: try #require(finding.choices.first { $0.answer == "defer" })))
		await screen.show(.decided, filter: nil)
		let decided = try #require(screen.questions.first { $0.ref == finding.ref })
		#expect(decided.decision?.label == "Defer" && decided.decision?.by == [Live.name])
		await screen.show(.open, filter: .map)
		#expect(screen.questions.map(\.kind) == [.map])
		// The counts stay the whole project's, so the filters can say how many each would show.
		#expect(screen.counts.open == 3 && screen.counts.open(of: .failure) == 1)
	}

	@Test("an accepted edit is not offered to undo: the case's history is where it is undone")
	func acceptedEdit() async throws {
		let screen = try await screen()
		let adopt = try #require(screen.questions.first { $0.kind == .adopt })
		guard case .proposal(let edit) = adopt.evidence else {
			Issue.record("the proposal's evidence was not read")
			return
		}
		// An edit nobody was shown is not accepted: the answer waits for what it changes to be read.
		let accept = try #require(adopt.choices.first { $0.answer == "accept" })
		#expect(!screen.isShown(adopt))
		#expect(await screen.answer(adopt, with: accept) == false)
		#expect(screen.notice?.text == "Nothing was recorded for \(adopt.ref): what it asks about has not been shown yet.")
		#expect(screen.current(adopt.ref) != nil)
		await screen.readDocuments(of: adopt)
		guard case .read(let documents) = screen.documents(of: adopt) else {
			Issue.record("what the edit changes was not read")
			return
		}
		#expect(documents.count == 1 && screen.isShown(adopt))
		#expect(await screen.answer(adopt, with: accept))
		#expect(screen.notice?.text == "\(adopt.ref): Accept.")
		#expect(screen.notice?.undoes == nil)
	}

	@Test("an answer the policy does not take is said so, in the server's words, and the question stays")
	func notTaken() async throws {
		let screen = try await screen(strict: true)
		let signoff = try #require(screen.questions.first { $0.kind == .signoff })
		let approve = try #require(signoff.choices.first { $0.answer == "approve" })
		#expect(await screen.answer(signoff, with: approve) == false)
		#expect(screen.notice?.text == "Nothing was recorded for \(signoff.ref). The server asks for a reason.")
		#expect(screen.notice?.isProblem == true)
		#expect(screen.current(signoff.ref) != nil)
		#expect(await screen.answer(signoff, with: approve, reason: "Checked on the release build."))
		#expect(screen.current(signoff.ref) == nil)
		// Undo is offered, and withdrawing is a decision too: the policy asks it for a reason as well.
		let undoes = try #require(screen.notice?.undoes)
		#expect(undoes.wantsReason)
		await screen.withdraw(undoes)
		#expect(screen.notice?.text == "The decision on \(signoff.ref) stands. The server asks for a reason.")
		await screen.withdraw(undoes, reason: "Closed too early.")
		#expect(screen.notice?.text == "\(signoff.ref): the decision is withdrawn.")
		#expect(screen.current(signoff.ref) != nil)
	}

	@Test("a change made elsewhere is on the screen after it is read again")
	func refresh() async throws {
		let server = try await Live.signedIn()
		let key = try await Live.project()
		let screen = QueueScreen(project: server.project(key))
		await screen.show(.open, filter: nil)
		// Somebody else answers: the same project, another connection.
		let other = try await Live.signedIn().project(key)
		let failure = try #require(try await other.questions(open: true, kind: .failure).questions.first)
		_ = try await other.answer(failure, with: try #require(failure.choices.first { $0.answer == "infra" }))
		#expect(screen.current(failure.ref) != nil)
		await screen.refresh()
		#expect(screen.current(failure.ref) == nil)
	}
}

@Suite("The queue screen, when the server does not answer")
@MainActor
struct QueueScreenFailureTests {
	/// A transport that never reaches anything.
	struct Down: Transport {
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			throw URLError(.cannotConnectToHost)
		}

		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			throw URLError(.cannotConnectToHost)
		}
	}

	/// A queue of three questions that the server hands out two at a time.
	struct TwoPages: Transport {
		func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
			func question(_ ref: String) -> String {
				"""
				{"q":"\(ref)","kind":"map","title":"Tests with no case","producer":"ci","state":"open","evidenceHash":"abc",
				"evidence":{"file":"a.spec.ts","tests":[],"count":0,"facts":[]},"seen":{"count":1,"carried":0},
				"needs":"one member","answers":["track"],"blocks":[],"about":[],"openedAt":1800000000000,"advice":[],
				"decision":null,"you":"counts"}
				"""
			}
			let asked = String(decoding: request.httpBody ?? Data(), as: UTF8.self)
			if request.url?.lastPathComponent == "get" {
				// One question by its ref: Q-3 is open, and Q-9 was decided since.
				let body = asked.contains("Q-9")
					? question("Q-9").replacingOccurrences(of: #""state":"open""#, with: #""state":"decided""#)
					: question("Q-3")
				return (
					Data(#"{"ok":true,"seq":1,"result":[\#(body)]}"#.utf8),
					HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
				)
			}
			let second = asked.contains(#""cursor":"next""#)
			let items = second ? question("Q-3") : "\(question("Q-1")),\(question("Q-2"))"
			let body = #"{"ok":true,"seq":1,"result":{"counts":{"open":3,"map":3},"cursor":\#(second ? "null" : #""next""#),"items":[\#(items)]}}"#
			return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
		}

		func lines(_ request: URLRequest) async throws -> (AsyncThrowingStream<String, any Error>, HTTPURLResponse) {
			throw URLError(.unsupportedURL)
		}
	}

	@Test("a list that was read past its first page is read as far again, so an open question stays in it")
	func refreshKeepsPages() async throws {
		let server = Server(instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: TwoPages())
		let screen = QueueScreen(project: server.project("shop"))
		await screen.show(.open, filter: nil)
		#expect(screen.questions.map(\.ref) == ["Q-1", "Q-2"] && screen.hasMore)
		await screen.more()
		#expect(screen.questions.map(\.ref) == ["Q-1", "Q-2", "Q-3"] && !screen.hasMore)
		// Somebody writes in the project, and the list is read again while Q-3 is open.
		await screen.refresh()
		#expect(screen.current("Q-3") != nil)
		#expect(screen.questions.count == 3 && !screen.hasMore)
	}

	@Test("a question whose page is open is read by itself where the list does not hold it")
	func openedBeyondTheList() async throws {
		let server = Server(instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: TwoPages())
		let screen = QueueScreen(project: server.project("shop"))
		await screen.show(.open, filter: nil)
		// The list was read as far as Q-2. Q-3 is opened from another screen, or pushed down by a new question.
		#expect(screen.current("Q-3") == nil)
		await screen.open("Q-3")
		#expect(screen.current("Q-3")?.isOpen == true)
		await screen.refresh()
		#expect(screen.questions.count == 2 && screen.current("Q-3") != nil)
		// A question that was decided meanwhile is not shown as one that still waits.
		await screen.open("Q-9")
		#expect(screen.current("Q-9") == nil)
		screen.close("Q-9")
	}

	@Test("the first read that fails says why, in place of the list")
	func firstReadFails() async throws {
		let server = Server(instance: try #require(Instance(address: "mainworthy.example")), secrets: MemoryStore(), transport: Down())
		let screen = QueueScreen(project: server.project("shop"))
		await screen.show(.open, filter: nil)
		guard case .failed(let why) = screen.loading else {
			Issue.record("the screen did not say the read failed")
			return
		}
		#expect(why.hasPrefix("The server could not be reached."))
		#expect(screen.questions.isEmpty)
	}
}
