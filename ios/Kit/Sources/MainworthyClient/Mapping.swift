import Foundation

/// One answer on the tests the person saw. The command and body stay together across uncertain replies.
package struct MappingSubmission: Sendable {
	let input: JSONValue

	package init(question: Question, creating: Bool, selections: [String: SuiteCase], reason: String) throws {
		guard question.kind == .map, question.isOpen,
			case .unlinked(let evidence) = question.evidence,
			!evidence.tests.isEmpty, evidence.count == evidence.tests.count,
			Set(evidence.tests.map(\.ref)).count == evidence.tests.count,
			question.choices.contains(where: { $0.answer == (creating ? "create" : "link") })
		else { throw ClientError.unreadable }
		var answer: [String: JSONValue] = ["is": .string(creating ? "create" : "link")]
		if !creating {
			answer["pairs"] = .array(try evidence.tests.map { test in
				guard let selected = selections[test.ref] else { throw ClientError.unreadable }
				return [.string(test.ref), .string(selected.ref)]
			})
		}
		var input: [String: JSONValue] = [
			"q": .string(question.ref), "onEvidence": .string(question.evidenceHash), "ifOpen": true,
			"answer": .object(answer), "cmd": .string(UUID().uuidString.lowercased()),
		]
		let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
		if !reason.isEmpty { input["reason"] = .string(reason) }
		self.input = .object(input)
	}
}

extension ProjectClient {
	package func answerMapping(_ submission: MappingSubmission) async throws -> AnswerOutcome {
		// This request already has a command id, as SuiteSubmission does. Do not mint another on retry.
		let replies: [Wire.DecideReply] = try await server.read("decide", in: key, submission.input)
		guard replies.count == 1, let reply = replies.first else { throw ClientError.unreadable }
		return try AnswerOutcome(reply)
	}
}
