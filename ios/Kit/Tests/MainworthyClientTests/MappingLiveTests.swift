import Foundation
import TestSupport
import Testing

@testable import MainworthyClient

@Suite("Mapping tests to cases", .enabled(if: Live.isRunning, "needs `bun scripts/ios.ts test`"))
struct MappingLiveTests {
	@Test("existing and new cases use the shown evidence and one stable command", arguments: [false, true])
	func mapping(creating: Bool) async throws {
		let server = try await Live.signedIn()
		let key = try await Live.project()
		let project = try await server.project(key)
		let question = try #require(try await project.questions(open: true, kind: .map).questions.first)
		guard case .unlinked(let evidence) = question.evidence else { Issue.record("no tests"); return }
		let test = try #require(evidence.tests.first)
		let selected = try #require(try await project.cases(text: "password").items.first)
		let submission = try MappingSubmission(question: question, creating: creating, selections: [test.ref: selected], reason: "Reviewed")
		#expect(submission.input["onEvidence"]?.string == question.evidenceHash)
		#expect(submission.input["ifOpen"] == true)
		#expect(submission.input["cmd"]?.string?.count == 36)
		let outcome = try await project.answerMapping(submission)
		#expect(outcome.isDecided)
		#expect(try await project.answerMapping(submission) == outcome)
		let tests: [JSONValue] = try await server.read("get", in: key, ["refs": [.string(test.ref)]])
		let linked = try #require(tests.first?["case"]?.string)
		if creating {
			let created = try await project.caseDocument(linked)
			#expect(created.content.title == "Shipping accepts an address")
			#expect(created.content.methods == ["auto"])
			#expect(try await project.cases(text: "Shipping accepts an address").items.count == 1)
		} else { #expect(linked == selected.ref) }
	}
}
