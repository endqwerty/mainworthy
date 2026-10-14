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

	/// The cases a proposal would make or change, each as it is and as it would be. Only a proposal that is
	/// shown whole (`ProposedEdit.isShownWhole`) has all its documents: for such a one, a reply that lacks a
	/// document, or the case an edit changes as it is now, is not read as fewer changes. It is unreadable,
	/// and nothing of it is shown as the whole.
	package func documents(of edit: ProposedEdit) async throws -> [EditedCase] {
		let rows: [Wire.Proposal] = try await server.read("get", in: key, ["refs": [.string(edit.proposal)]])
		guard let found = rows.first, found.ref == edit.proposal else { throw ClientError.unreadable }
		let documents = try found.edits.enumerated().compactMap { index, part -> EditedCase? in
			switch part.op {
			case "create":
				guard let body = part.body, let folder = part.folder, let tags = part.tags?.array, let covers = part.covers
				else { throw ClientError.unreadable }
				// Every tag is a word. One that is not is not dropped: what is shown must be all there is.
				let words = tags.compactMap(\.string)
				guard words.count == tags.count else { throw ClientError.unreadable }
				return EditedCase(
					id: index, caseRef: nil, before: nil, after: CaseContent(body),
					placement: .init(folder: folder, tags: words, covers: covers)
				)
			case "edit":
				guard let body = part.body, let current = part.current, let ref = part.case
				else { throw ClientError.unreadable }
				return EditedCase(id: index, caseRef: ref, before: CaseContent(current), after: CaseContent(body))
			default:
				return nil
			}
		}
		// What the question counted is what must be here.
		guard !edit.isShownWhole || documents.count == edit.count else { throw ClientError.unreadable }
		return documents
	}

	/// One question by its ref, open or decided, or nil when the project has none such.
	///
	/// `get` reads it, and does not say what this person's answer is worth: only a listing does. So the
	/// question is then looked for in the listing of what one of its subjects is about (a change, a run, a
	/// case), which is one page however long the queue is. Where no such listing holds it, the question is
	/// returned as `get` gave it, with a standing that is not known.
	package func question(_ ref: String) async throws -> Question? {
		let rows: [Wire.Question] = try await server.read("get", in: key, ["refs": [.string(ref)]])
		guard let alone = rows.first else { return nil }
		for subject in alone.about.prefix(3) {
			let input: JSONValue = [
				"state": alone.state == "open" ? "open" : "decided", "on": .string(subject), "limit": 500,
			]
			let listed: Wire.Inbox? = try? await server.read("inbox", in: key, input)
			if let found = listed?.items.first(where: { $0.q == ref }) { return Question(found) }
		}
		return Question(alone)
	}
}
