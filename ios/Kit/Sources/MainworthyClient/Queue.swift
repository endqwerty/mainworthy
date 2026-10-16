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

	/// Answers a question on the evidence it was read with, at once and without saving it: for tests and tools.
	/// The app saves every answer first (`AnswerOutbox.record`).
	///
	/// - Parameters:
	///   - reference: For "Defect in the product": where the defect is tracked. May be empty.
	///   - reason: Why. The policy can ask for one (`Question.wantsReason`).
	package func answer(
		_ question: Question, with choice: Choice, reference: String = "", reason: String = ""
	) async throws -> AnswerOutcome {
		guard let answer = prepareAnswer([question], with: choice, reference: reference, reason: reason) else {
			return .notTaken("an answer this build can give; open the question in the web app")
		}
		return try await send(answer)[question.ref] ?? .notTaken("an answer the server did not give")
	}

	/// Captures one answer to these questions once, before the device saves it or sends it: one command, each
	/// question on the evidence it was read with, refused if somebody decided it meanwhile. Nil when a question
	/// does not take the answer, when the questions repeat, or when there are more than one request carries.
	package func prepareAnswer(
		_ questions: [Question], with choice: Choice, reference: String = "", reason: String = ""
	) -> PreparedAnswer? {
		guard choice.takes != .more, (1...decideMax).contains(questions.count),
			Set(questions.map(\.ref)).count == questions.count else { return nil }
		let reference = reference.trimmingCharacters(in: .whitespacesAndNewlines)
		var decisions: [JSONValue] = []
		for question in questions {
			guard let own = question.choices.first(where: { $0.answer == choice.answer }), own.takes != .more
			else { return nil }
			var answer: [String: JSONValue] = ["is": .string(own.answer)]
			if own.takes == .reference, !reference.isEmpty { answer["ref"] = .string(reference) }
			if case .finding(let finding) = question.evidence, own.answer == "accept" {
				answer["apply"] = .bool(finding.suggestion != nil)
			}
			decisions.append([
				"q": .string(question.ref), "onEvidence": .string(question.evidenceHash), "answer": .object(answer),
				"ifOpen": true,
			])
		}
		var input: [String: JSONValue] = ["all": .array(decisions)]
		let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
		if !reason.isEmpty { input["reason"] = .string(reason) }
		return PreparedAnswer(
			members: questions.map { .init(question: $0.ref, title: $0.title) }, label: choice.label,
			input: .object(input)
		)
	}

	/// One question's answer, as `prepareAnswer` captures several.
	package func prepareAnswer(
		_ question: Question, with choice: Choice, reference: String = "", reason: String = ""
	) -> PreparedAnswer? {
		prepareAnswer([question], with: choice, reference: reference, reason: reason)
	}

	/// Sends a saved answer as it was saved, under its command id, and returns what became of each question.
	package func send(_ answer: PreparedAnswer, delivery: WriteDelivery? = nil) async throws -> [String: AnswerOutcome] {
		let replies: [Wire.DecideReply] = try await server.write(
			"decide", in: key, answer.input, command: answer.command, delivery: delivery
		)
		return try answer.outcomes(replies)
	}

	/// Asks what became of this exact command without sending the saved answer again.
	package func answerCommand(_ answer: PreparedAnswer) async throws -> AnswerCommand {
		let command: Wire.AnswerCommand = try await server.read("command", in: key, ["cmd": .string(answer.command)])
		switch command.state {
		case "none": return .notRecorded
		case "begun": return .recording
		case "done":
			guard let replies = command.reply else { throw ClientError.unreadable }
			return .recorded(try answer.outcomes(replies))
		default: throw ClientError.unreadable
		}
	}

	/// Withdraws the decision that stands on a question. Both decisions stay in the ledger. The policy can ask
	/// for a reason here too.
	package func withdraw(_ question: Question, reason: String = "") async throws -> WithdrawOutcome {
		var input: [String: JSONValue] = ["undo": .string(question.ref)]
		if let decision = question.ifDecision { input["ifDecision"] = .number(Double(decision)) }
		let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
		if !reason.isEmpty { input["reason"] = .string(reason) }
		let reply = try await decide(.object(input))
		return reply.status == "reopened"
			? .withdrawn(reply.needs)
			: .notTaken(reply.needs ?? "another request (\(reply.status))")
	}

	/// `decide` answers with one reply for each question it was sent. A withdrawal is of one question.
	private func decide(_ input: JSONValue) async throws -> Wire.DecideReply {
		let replies: [Wire.DecideReply] = try await server.write("decide", in: key, input)
		guard let reply = replies.first, replies.count == 1 else { throw ClientError.unreadable }
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

package enum AnswerCommand {
	case notRecorded
	case recording
	/// What became of each question of the answer.
	case recorded([String: AnswerOutcome])
}

extension AnswerOutcome {
	init(_ reply: Wire.DecideReply) throws {
		if reply.status == "decided" || reply.status == "already" {
			guard let decision = reply.decision else { throw ClientError.unreadable }
			self = .decided(decision)
			return
		}
		self = switch reply.status {
		case "advised": .advised(reply.needs ?? "Somebody else decides.")
		case "conflict": .overtaken(reply.needs ?? "the question changed")
		default: .notTaken(reply.needs ?? "another answer (\(reply.status))")
		}
	}
}

/// An answer to one or more questions, captured once: one command, sent as it was saved. Replaying it changes
/// neither the evidence nor the command id.
///
/// An answer saved by an earlier build answers one question with a `decide` input of that question alone. It is
/// read as an answer of one member and sent as it was saved: the server ties a command id to its request, so the
/// same id with the request written another way would be refused as another command.
package struct PreparedAnswer: Codable, Equatable, Sendable {
	package struct Member: Codable, Equatable, Sendable {
		package let question: String
		package let title: String
	}

	package let command: String
	/// What the answer is called: "Flaky".
	package let label: String
	/// The questions it answers, in the order they are sent: one at least, and at most `decideMax`.
	package let members: [Member]
	let input: JSONValue

	init(members: [Member], label: String, input: JSONValue) {
		command = UUID().uuidString.lowercased()
		self.members = members
		self.label = label
		self.input = input
	}

	private enum Keys: String, CodingKey {
		case command, label, members, input
		/// An answer an earlier build saved names its one question here.
		case question, title
	}

	package init(from decoder: any Decoder) throws {
		let container = try decoder.container(keyedBy: Keys.self)
		command = try container.decode(String.self, forKey: .command)
		label = try container.decode(String.self, forKey: .label)
		input = try container.decode(JSONValue.self, forKey: .input)
		if let members = try container.decodeIfPresent([Member].self, forKey: .members) {
			self.members = members
		} else {
			members = [Member(
				question: try container.decode(String.self, forKey: .question),
				title: try container.decode(String.self, forKey: .title)
			)]
		}
		guard !members.isEmpty, Set(members.map(\.question)).count == members.count else {
			throw ClientError.unreadable
		}
	}

	package func encode(to encoder: any Encoder) throws {
		var container = encoder.container(keyedBy: Keys.self)
		try container.encode(command, forKey: .command)
		try container.encode(label, forKey: .label)
		try container.encode(members, forKey: .members)
		try container.encode(input, forKey: .input)
	}

	/// What became of each question, from the replies to this command. They must name every question once and no
	/// other, whatever their order: a reply that does not is not read as fewer answers. It is unreadable, and the
	/// answer stays as uncertain as it was.
	func outcomes(_ replies: [Wire.DecideReply]) throws -> [String: AnswerOutcome] {
		let asked = Set(members.map(\.question))
		guard replies.count == members.count, Set(replies.map(\.q)) == asked else { throw ClientError.unreadable }
		var outcomes: [String: AnswerOutcome] = [:]
		for reply in replies { outcomes[reply.q] = try AnswerOutcome(reply) }
		return outcomes
	}
}
