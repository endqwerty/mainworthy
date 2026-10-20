import Foundation
import Testing

@testable import MainworthyClient

/// How an answer is captured, read back from a saved file, and checked against the server's replies, with no
/// server: what the outbox relies on whatever the network does (decision 0088).
@Suite("A saved answer")
struct PreparedAnswerTests {
	let project = Server(
		instance: Instance(address: "mainworthy.example")!, secrets: MemoryStore(), transport: URLSessionTransport(),
		userAgent: "Mainworthy tests"
	).project("demo", identity: "demo-identity")

	/// An unlinked question as a listing gives it.
	func question(_ number: Int) throws -> Question {
		let json = """
			{"q":"Q-\(number)","kind":"map","title":"1 test in tests/f\(number).spec.ts has no case","producer":"ci",
			"state":"open","evidence":{"file":"tests/f\(number).spec.ts","tests":[],"count":1,"facts":[]},
			"evidenceHash":"hash-\(number)","seen":{"count":1,"carried":0},"needs":"one member","answers":["link","create","track"],
			"blocks":[],"about":[],"openedAt":0,"advice":[],"you":"counts","decision":null}
			"""
		return Question(try JSONDecoder().decode(Wire.Question.self, from: Data(json.utf8)))
	}

	func reply(_ q: String, _ status: String = "decided", decision: Int? = 1) throws -> Wire.DecideReply {
		let json = #"{"q":"\#(q)","status":"\#(status)","needs":null,"decision":\#(decision.map(String.init) ?? "null"),"evidence":null}"#
		return try JSONDecoder().decode(Wire.DecideReply.self, from: Data(json.utf8))
	}

	@Test("one answer to several questions is one request, each on its own evidence")
	func batch() throws {
		let questions = try (1...3).map(question)
		let track = try #require(questions[0].choices.first { $0.answer == "track" })
		let answer = try #require(project.prepareAnswer(questions, with: track, reason: " Kept on purpose "))
		#expect(answer.members.map(\.question) == ["Q-1", "Q-2", "Q-3"] && answer.label == "Track without a case")
		let all = try #require(answer.input["all"]?.array)
		#expect(all.map { $0["q"]?.string } == ["Q-1", "Q-2", "Q-3"])
		#expect(all.map { $0["onEvidence"]?.string } == ["hash-1", "hash-2", "hash-3"])
		#expect(all.allSatisfy { $0["ifOpen"] == true && $0["answer"]?["is"]?.string == "track" })
		#expect(answer.input["reason"]?.string == "Kept on purpose")
		// One question is a batch of one: there is one way to answer.
		#expect(try #require(project.prepareAnswer(questions[0], with: track)).input["all"]?.array?.count == 1)
	}

	@Test("an answer to more than one request carries, or to a question twice, is not prepared")
	func bounds() throws {
		let track = try #require(try question(1).choices.first { $0.answer == "track" })
		let most = try (1...decideMax).map(question)
		#expect(project.prepareAnswer(most, with: track)?.members.count == decideMax)
		#expect(project.prepareAnswer(most + [try question(decideMax + 1)], with: track) == nil)
		#expect(project.prepareAnswer([try question(1), try question(1)], with: track) == nil)
		#expect(project.prepareAnswer([], with: track) == nil)
	}

	@Test("the replies must name every question once and no other, in any order")
	func replies() throws {
		let questions = try (1...2).map(question)
		let track = try #require(questions[0].choices.first { $0.answer == "track" })
		let answer = try #require(project.prepareAnswer(questions, with: track))
		let read = try answer.outcomes([try reply("Q-2", "conflict", decision: nil), try reply("Q-1", decision: 7)])
		#expect(read == ["Q-1": .decided(7), "Q-2": .overtaken("the question changed")])
		for broken in [
			[try reply("Q-1")],
			[try reply("Q-1"), try reply("Q-1")],
			[try reply("Q-1"), try reply("Q-3")],
			[try reply("Q-1"), try reply("Q-2"), try reply("Q-3")],
			[try reply("Q-1"), try reply("Q-2", decision: nil)],
		] {
			#expect(throws: ClientError.unreadable) { try answer.outcomes(broken) }
		}
	}

	@Test("an answer an earlier build saved is read without an identity for an obsolete outcome")
	func legacy() throws {
		let saved = #"{"command":"c-1","question":"Q-4","title":"Flaky test","label":"Flaky","input":{"q":"Q-4","onEvidence":"h","answer":{"is":"flaky"},"ifOpen":true}}"#
		let answer = try JSONDecoder().decode(PreparedAnswer.self, from: Data(saved.utf8))
		#expect(answer.projectIdentity == nil)
		#expect(answer.command == "c-1" && answer.members == [.init(question: "Q-4", title: "Flaky test")])
		#expect(answer.input["q"]?.string == "Q-4" && answer.input["all"] == nil)
		let again = try JSONDecoder().decode(PreparedAnswer.self, from: JSONEncoder().encode(answer))
		#expect(again == answer)
		#expect(try answer.outcomes([try reply("Q-4", decision: 3)]) == ["Q-4": .decided(3)])
	}
}
