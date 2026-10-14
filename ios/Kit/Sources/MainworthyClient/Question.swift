import Foundation

/// What a question is about. The server has five kinds. One it adds later arrives as `other`: the app shows
/// such a question by its title and does not offer to answer what it cannot show the evidence of.
public enum Kind: Hashable, Sendable {
	case adopt, map, failure, finding, signoff
	case other(String)

	init(_ word: String) {
		switch word {
		case "adopt": self = .adopt
		case "map": self = .map
		case "failure": self = .failure
		case "finding": self = .finding
		case "signoff": self = .signoff
		default: self = .other(word)
		}
	}

	/// The server's word for it.
	package var word: String {
		switch self {
		case .adopt: "adopt"
		case .map: "map"
		case .failure: "failure"
		case .finding: "finding"
		case .signoff: "signoff"
		case .other(let word): word
		}
	}

	/// The kinds a queue is filtered by, in the order the web shows them.
	public static let known: [Kind] = [.failure, .adopt, .map, .finding, .signoff]

	/// What the queue calls one such question, as the web does.
	public var name: String {
		switch self {
		case .adopt: "proposal"
		case .map: "unlinked"
		case .failure: "failure"
		case .finding: "finding"
		case .signoff: "sign-off"
		case .other(let word): word
		}
	}

	/// What the queue calls several, for a filter.
	public var plural: String {
		switch self {
		case .adopt: "Proposals"
		case .map: "Unlinked"
		case .failure: "Failures"
		case .finding: "Findings"
		case .signoff: "Sign-offs"
		case .other(let word): word.capitalized
		}
	}
}

/// Who produced something: a person, an agent, a pipeline, or the policy's own rule.
public enum Producer: Hashable, Sendable {
	case person, agent, pipeline, rule

	init(_ word: String) {
		switch word {
		case "agent": self = .agent
		case "ci": self = .pipeline
		case "rule": self = .rule
		default: self = .person
		}
	}
}

/// One question of the queue, with the evidence it asks about.
public struct Question: Identifiable, Equatable, Sendable {
	public var id: String { ref }
	/// For example Q-12.
	public let ref: String
	public let kind: Kind
	public let title: String
	public let producer: Producer
	public let isOpen: Bool
	public let evidence: Evidence
	/// How often the cause was seen.
	public let timesSeen: Int
	/// Who the question waits for, as the server's sentence: "one member with a reason".
	public let needs: String
	/// The answers that apply, in the order to show them.
	public let choices: [Choice]
	/// The runs the question is listed as blocking.
	public let blocks: [String]
	public let openedAt: Date
	/// Answers that were recorded as advice, for whoever decides.
	public let advice: [Advice]
	/// What this person's answer would be worth.
	public let standing: Standing
	/// The decision that stands, on a question that is decided.
	public let decision: Decision?
	/// What an answer must say it was given on, so that an answer to evidence that has changed since is not
	/// taken. Only `ProjectClient.answer` reads it: a screen cannot answer on evidence it was not handed.
	package let evidenceHash: String
	let facts: Set<String>

	/// Whether leaving it open holds anything up. Only an unexplained failure does.
	public var isUrgent: Bool { Stakes.urgent(kind) }

	/// What happens while it stays open, in a sentence.
	public var stakes: String { Stakes.sentence(kind: kind, blocks: blocks, facts: facts) }

	/// Whether the policy asks for a reason with the answer. The server refuses an answer without one; asking
	/// first saves the person the refusal.
	public var wantsReason: Bool { needs.contains("with a reason") }
}

extension Question {
	init(_ wire: Wire.Question) {
		ref = wire.q
		kind = Kind(wire.kind)
		title = wire.title
		producer = Producer(wire.producer)
		isOpen = wire.state == "open"
		evidence = Evidence(kind: Kind(wire.kind), wire.evidence)
		timesSeen = wire.seen.count
		needs = wire.needs
		choices = wire.answers.map { Choice(answer: $0, for: Kind(wire.kind)) }
		blocks = wire.blocks
		openedAt = Date(milliseconds: wire.openedAt)
		advice = wire.advice.map(Advice.init)
		standing = Standing(wire.you)
		decision = wire.decision.map(Decision.init)
		evidenceHash = wire.evidenceHash
		facts = Set(wire.evidence["facts"]?.array?.compactMap(\.string) ?? [])
	}
}

/// What a person's answer is worth under the policy.
public enum Standing: Sendable {
	/// It settles the question.
	case counts
	/// It is recorded, and somebody else decides.
	case advice
	/// The policy does not let this person answer.
	case forbidden

	init(_ word: String?) {
		switch word {
		case "advice": self = .advice
		case "forbidden": self = .forbidden
		// Absent outside a listing, and the server decides either way.
		default: self = .counts
		}
	}
}

/// One answer a question can be given.
public struct Choice: Identifiable, Hashable, Sendable {
	public var id: String { answer }
	/// The server's word: `flaky`.
	public let answer: String
	/// What it is called: "Flaky".
	public let label: String
	/// What it does, in a sentence. Empty for an answer this build has no words for.
	public let help: String
	/// What the answer takes beside itself.
	public let takes: Takes

	public enum Takes: Sendable {
		case nothing
		/// A reference to where the defect is tracked, which may be left empty.
		case reference
		/// Something this build cannot give: the cases to link tests to, the text of a merge, or an answer the
		/// app has no words for. The question is answered in the web app.
		case more
	}

	init(answer: String, for kind: Kind) {
		self.answer = answer
		label = Vocabulary.answerLabels[answer] ?? answer.capitalized
		let help = Vocabulary.answerHelp[kind.word]?[answer]
		self.help = help ?? ""
		takes =
			switch answer {
			case _ where help == nil: .more
			case "link", "merge": .more
			case "defect": .reference
			default: .nothing
			}
	}
}

public struct Decision: Equatable, Sendable {
	/// What the answer is called: "Flaky", or "Withdrawn" for a row the ledger wrote itself.
	public let label: String
	/// Where a defect is tracked, when the answer said.
	public let reference: String?
	/// Who signed it.
	public let by: [String]
	/// Whether the policy's rule gave it and no person did.
	public let byRule: Bool
	public let reason: String?
	public let at: Date

	init(_ wire: Wire.Decision) {
		let answer = wire.answer["is"]?.string ?? ""
		label = Vocabulary.answerLabels[answer] ?? answer.capitalized
		reference = wire.answer["ref"]?.string
		by = wire.by
		byRule = wire.rule != nil
		reason = wire.reason
		at = Date(milliseconds: wire.at)
	}
}

public struct Advice: Equatable, Sendable {
	public let by: String
	public let producer: Producer
	public let label: String
	public let reason: String?

	init(_ wire: Wire.Advice) {
		by = wire.by
		producer = Producer(wire.kind)
		let answer = wire.answer["is"]?.string ?? ""
		label = Vocabulary.answerLabels[answer] ?? answer.capitalized
		reason = wire.reason
	}
}

/// A page of the queue.
public struct QuestionPage: Equatable, Sendable {
	public let questions: [Question]
	public let counts: QueueCounts
	/// What to ask for the next page with, or nil at the end.
	package let next: String?
}

/// How many questions are open, by kind. They are the whole project's, whatever the page was filtered by.
public struct QueueCounts: Equatable, Sendable {
	private let counts: [String: Int]

	package init(_ counts: [String: Int] = [:]) {
		self.counts = counts
	}

	public var open: Int { counts["open"] ?? 0 }

	public func open(of kind: Kind) -> Int {
		counts[kind.word] ?? 0
	}

	/// "1 failure to explain · 104 can wait".
	public var phrase: String { Stakes.waitingPhrase(counts) }
}

/// What became of an answer.
public enum AnswerOutcome: Equatable, Sendable {
	/// It settled the question.
	case decided
	/// It was recorded as advice. The sentence says who decides.
	case advised(String)
	/// Nothing was recorded, because the question is not what the person read any more: its evidence changed,
	/// or it no longer applies. The server's sentence. The person reads the question again.
	case overtaken(String)
	/// The server did not take it. What it asks for instead: "a reason", "one member who is not an agent".
	case notTaken(String)
}

/// What became of withdrawing a decision.
public enum WithdrawOutcome: Equatable, Sendable {
	/// The decision is withdrawn. Both stay in the ledger. The question is open again, unless the server says
	/// in its sentence why nobody is asked.
	case withdrawn(String?)
	/// The server did not withdraw it. What it asks for instead.
	case notTaken(String)
}
