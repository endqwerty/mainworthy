import Foundation

/// The queue: reading it, answering a question, withdrawing a decision, and reading what an edit changes.
extension ProjectClient {
	/// A page of the queue: the open questions, or the ones that are decided, newest decision first.
	package func questions(open: Bool, kind: Kind? = nil, after cursor: String? = nil) async throws -> QuestionPage {
		var input: [String: JSONValue] = ["state": open ? "open" : "decided", "limit": 100]
		if let kind { input["kind"] = .string(kind.word) }
		if let cursor { input["cursor"] = .string(cursor) }
		let wire: Wire.Inbox = try await server.read("inbox", in: key, .object(input))
		return QuestionPage(
			questions: wire.items.map(Question.init), counts: QueueCounts(wire.counts), next: wire.cursor
		)
	}

	/// Answers a question on the evidence it was read with.
	///
	/// - Parameters:
	///   - reference: For "Defect in the product": where the defect is tracked. May be empty.
	///   - reason: Why. The policy can ask for one (`Question.wantsReason`).
	package func answer(
		_ question: Question, with choice: Choice, reference: String = "", reason: String = ""
	) async throws -> AnswerOutcome {
		guard choice.takes != .more, question.choices.contains(choice) else {
			return .notTaken("an answer this build can give; open the question in the web app")
		}
		var answer: [String: JSONValue] = ["is": .string(choice.answer)]
		let reference = reference.trimmingCharacters(in: .whitespacesAndNewlines)
		if choice.takes == .reference, !reference.isEmpty { answer["ref"] = .string(reference) }
		// Accepting a finding that suggests an edit makes the edit a proposal by its finder, as the web does.
		if case .finding(let finding) = question.evidence, choice.answer == "accept" {
			answer["apply"] = .bool(finding.suggestion != nil)
		}
		var input: [String: JSONValue] = [
			"q": .string(question.ref), "onEvidence": .string(question.evidenceHash), "answer": .object(answer),
		]
		let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
		if !reason.isEmpty { input["reason"] = .string(reason) }
		let reply = try await decide(.object(input))
		return switch reply.status {
		case "decided", "already": .decided
		case "advised": .advised(reply.needs ?? "Somebody else decides.")
		case "conflict": .overtaken(reply.needs ?? "the question changed")
		default: .notTaken(reply.needs ?? "another answer (\(reply.status))")
		}
	}

	/// Withdraws the decision that stands on a question. Both decisions stay in the ledger. The policy can ask
	/// for a reason here too.
	package func withdraw(_ question: Question, reason: String = "") async throws -> WithdrawOutcome {
		var input: [String: JSONValue] = ["undo": .string(question.ref)]
		let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
		if !reason.isEmpty { input["reason"] = .string(reason) }
		let reply = try await decide(.object(input))
		return reply.status == "reopened"
			? .withdrawn(reply.needs)
			: .notTaken(reply.needs ?? "another request (\(reply.status))")
	}

	/// `decide` answers with one reply for each question it was sent. The app sends one.
	private func decide(_ input: JSONValue) async throws -> Wire.DecideReply {
		let replies: [Wire.DecideReply] = try await server.write("decide", in: key, input)
		guard let reply = replies.first else { throw ClientError.unreadable }
		return reply
	}

	/// The cases a proposed edit would change or make, each as it is and as it would be. An edit that changes
	/// no case's content (a move, a folder, the policy) has none: its line in the question says what it does.
	package func documents(of proposal: String) async throws -> [EditedCase] {
		let rows: [Wire.Proposal] = try await server.read("get", in: key, ["refs": [.string(proposal)]])
		guard let found = rows.first else { return [] }
		return found.edits.enumerated().compactMap { index, edit in
			edit.body.map { body in
				EditedCase(
					id: index, caseRef: edit.case, before: edit.current.map(CaseContent.init), after: CaseContent(body)
				)
			}
		}
	}
}
