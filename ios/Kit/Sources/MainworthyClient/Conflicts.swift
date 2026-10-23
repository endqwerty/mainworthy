import Foundation
import JavaScriptCore

/// The tagged address defined in the core contract. Step ids and field keys remain opaque values.
public enum ConflictAddress: Hashable, Decodable, Sendable {
	public enum Field: String, Hashable, Decodable, Sendable { case title, pre, methods, automate }
	public enum StepField: String, Hashable, Decodable, Sendable { case action, expected }
	case field(Field)
	case step(String)
	case stepField(String, StepField)
	case stepOrder
	case customField(String)

	private enum Keys: String, CodingKey { case kind, name, id, key }
	public init(from decoder: Decoder) throws {
		let value = try decoder.container(keyedBy: Keys.self)
		switch try value.decode(String.self, forKey: .kind) {
		case "field": self = .field(try value.decode(Field.self, forKey: .name))
		case "step": self = .step(try value.decode(String.self, forKey: .id))
		case "step-field": self = .stepField(try value.decode(String.self, forKey: .id), try value.decode(StepField.self, forKey: .name))
		case "step-order": self = .stepOrder
		case "custom-field": self = .customField(try value.decode(String.self, forKey: .key))
		default: throw DecodingError.dataCorruptedError(forKey: .kind, in: value, debugDescription: "Unknown conflict address")
		}
	}
	public var label: String {
		switch self {
		case .field(let name): return name.rawValue
		case .step(let id): return "Step ^\(id)"
		case .stepField(let id, let name): return "Step ^\(id) \(name.rawValue)"
		case .stepOrder: return "Step order"
		case .customField(let key): return "Field \(key)"
		}
	}
	package var json: JSONValue {
		switch self {
		case .field(let name): return ["kind": "field", "name": .string(name.rawValue)]
		case .step(let id): return ["kind": "step", "id": .string(id)]
		case .stepField(let id, let name): return ["kind": "step-field", "id": .string(id), "name": .string(name.rawValue)]
		case .stepOrder: return ["kind": "step-order"]
		case .customField(let key): return ["kind": "custom-field", "key": .string(key)]
		}
	}
}

/// A merge made on the documents the person saw, with no network or view state of its own.
public struct CaseConflict: Equatable, Sendable {
	public let question: String
	public let evidence: String
	public let wantsReason: Bool
	public let ref: String
	public let current: CaseContent
	public let mine: CaseContent
	public private(set) var merged: CaseContent
	public let addresses: [ConflictAddress]
	public private(set) var selections: [ConflictAddress: Side] = [:]
	public var chosen: Set<ConflictAddress> { Set(selections.keys) }

	package init(question: String, evidence: String, wantsReason: Bool = false, ref: String, base: CaseContent,
		mine: CaseContent, current: CaseContent) throws {
		self.question = question; self.evidence = evidence; self.wantsReason = wantsReason; self.ref = ref
		self.current = current; self.mine = mine
		let input: JSONValue = ["base": base.json, "mine": mine.json, "theirs": current.json]
		struct Result: Decodable {
			struct Conflict: Decodable { let address: ConflictAddress }
			let merged: Wire.CaseBody
			let conflicts: [Conflict]
		}
		let decoded: Result = try Self.evaluate("mergeCase", input: input)
		merged = CaseContent(decoded.merged)
		addresses = decoded.conflicts.map(\.address)
	}

	public var complete: Bool { Set(addresses).isSubset(of: chosen) }
	public enum Side: Equatable, Sendable { case mine, current }

	private static func evaluate<T: Decodable>(_ function: String, input: JSONValue) throws -> T {
		guard let context = JSContext() else { throw ClientError.unreadable }
		context.evaluateScript(MergeRuntime.source)
		let data = try JSONEncoder().encode(input)
		guard let text = String(data: data, encoding: .utf8),
			let result = context.objectForKeyedSubscript(function)?.call(withArguments: [text])?.toString(),
			context.exception == nil else { throw ClientError.unreadable }
		return try JSONDecoder().decode(T.self, from: Data(result.utf8))
	}

	public mutating func choose(_ address: ConflictAddress, side: Side) throws {
		guard addresses.contains(address) else { return }
		let body = side == .mine ? mine : current
		let order = address == .stepOrder ? side : selections[.stepOrder]
		var input: [String: JSONValue] = ["merged": merged.json, "source": body.json, "address": address.json]
		if let order { input["order"] = (order == .mine ? mine : current).json["steps"] }
		let decoded: Wire.CaseBody = try Self.evaluate("chooseCase", input: .object(input))
		merged = CaseContent(decoded)
		selections[address] = side
	}

	public func label(_ address: ConflictAddress) -> String {
		switch address {
		case .field(.title): return "Title"
		case .field(.pre): return "Preconditions"
		case .field(.methods): return "Methods"
		case .field(.automate): return "Automation"
		case .stepOrder: return "Step order"
		case .customField(let key): return "Field: " + key
		case .step(let id): return stepLabel(id)
		case .stepField(let id, let name): return stepLabel(id) + (name == .action ? " action" : " expected result")
		}
	}
	private func stepLabel(_ id: String) -> String {
		guard let index = mine.steps.firstIndex(where: { $0.id == id })
			?? current.steps.firstIndex(where: { $0.id == id }) else { return "Step " + id }
		return "Step \(index + 1)"
	}

	public func text(_ address: ConflictAddress, side: Side) -> String {
		let body = side == .mine ? mine : current
		switch address {
		case .field(.title): return body.title
		case .field(.pre): return body.pre.isEmpty ? "No preconditions" : body.pre
		case .field(.methods): return body.methods.joined(separator: ", ")
		case .field(.automate): return body.automate
		case .stepOrder: return body.steps.map { "\($0.id): \($0.action)" }.joined(separator: "\n")
		case .customField(let key): return body.fields[key] ?? "Field removed"
		case .step(let id):
			guard let step = body.steps.first(where: { $0.id == id }) else { return "Step removed" }
			return step.action + (step.expected.map { "\nExpected: \($0)" } ?? "")
		case .stepField(let id, let name):
			guard let step = body.steps.first(where: { $0.id == id }) else { return "Step removed" }
			return name == .action ? step.action : step.expected ?? "No expected result"
		}
	}

}

extension CaseContent {
	package var json: JSONValue { [
		"title": .string(title), "pre": .string(pre), "methods": .array(methods.map(JSONValue.string)),
		"automate": .string(automate), "fields": .object(fields.mapValues(JSONValue.string)),
		"steps": .array(steps.map(\.json)),
	] }
}

package struct MergeSubmission: Sendable {
	let input: JSONValue
	let ref: String
	let command = UUID().uuidString.lowercased()
	package init(_ conflict: CaseConflict, reason: String) {
		ref = conflict.ref
		var input: [String: JSONValue] = ["q": .string(conflict.question), "onEvidence": .string(conflict.evidence),
			"ifOpen": true, "answer": ["is": "merge", "body": conflict.merged.json], "cmd": .string(command)]
		if !reason.isEmpty { input["reason"] = .string(reason) }
		self.input = .object(input)
	}
}

package enum MergeOutcome: Sendable {
	case adopted(CaseStamp), unchanged, waiting(String), moved(String), refused(String), closed(String)
}

extension ProjectClient {
	package func conflict(_ question: String, ref: String) async throws -> CaseConflict {
		let questions: [Wire.Question] = try await server.read("get", in: key, ["refs": [.string(question)]])
		guard let q = questions.first, q.q == question, q.kind == "adopt", q.state == "open",
			let evidence = q.evidence.read(as: Wire.AdoptEvidence.self), !evidence.conflicts.isEmpty else {
			throw ClientError.refused(code: "conflict", message: "This conflict is no longer open. Your draft and choices are kept.")
		}
		let rows: [Wire.ConflictProposal] = try await server.read("get", in: key, ["refs": [.string(evidence.proposal)]])
		guard let row = rows.first, row.ref == evidence.proposal else { throw ClientError.unreadable }
		guard row.edits.count == 1 else {
			throw ClientError.refused(code: "invalid", message: "Use the web app to resolve a conflict with tag or requirement-link changes. Your draft is kept.")
		}
		guard let edit = row.edits.first, edit.op == "edit", edit.case == ref,
			let version = edit.base, let mine = edit.mine, let current = edit.current else { throw ClientError.unreadable }
		var base = try await caseDocument(ref, version: version).content
		// A case read alone omits custom fields. A history comparison includes all of them, even when
		// unchanged. Reading the base against itself supplies the exact values without guessing.
		let fields: Wire.ConflictBaseFields = try await server.read("history", in: key,
			["ref": .string(ref), "from": .number(Double(version)), "to": .number(Double(version))])
		guard fields.ref == ref, fields.from == version, fields.to == version else { throw ClientError.unreadable }
		base.fields = fields.diff.fields.before
		return try CaseConflict(question: question, evidence: q.evidenceHash, wantsReason: Question(q).wantsReason, ref: ref, base: base,
			mine: CaseContent(mine), current: CaseContent(current))
	}

	package func resolve(_ submission: MergeSubmission, recovering: Bool) async throws -> MergeOutcome {
		let replies: [Wire.MergeReply]
		if recovering {
			let command: Wire.MergeCommand = try await server.read("command", in: key, ["cmd": .string(submission.command)])
			switch command.state {
			case "done":
				guard let recorded = command.reply else { throw ClientError.unreadable }
				replies = recorded
			case "none": replies = try await server.read("decide", in: key, submission.input)
			case "begun": throw ClientError.refused(code: "busy", message: "The merge is still being recorded. Retry to ask again.")
			default: throw ClientError.unreadable
			}
		} else { replies = try await server.read("decide", in: key, submission.input) }
		guard replies.count == 1, let reply = replies.first, reply.q == submission.input["q"]?.string else { throw ClientError.unreadable }
		guard reply.status == "decided" else {
			let questions: [Wire.Question] = try await server.read("get", in: key, ["refs": [.string(reply.q)]])
			guard let question = questions.first, question.q == reply.q else { throw ClientError.unreadable }
			if question.state != "open" {
				let reason = question.state == "decided" ? "was answered elsewhere" : "is no longer open"
				return .closed("This question \(reason). Your draft and choices are kept here. Choose Cancel to leave this editor.")
			}
			return .refused(reply.needs ?? "The merge was not adopted (\(reply.status)). Your choices are kept.")
		}
		guard let effects = reply.effects else { throw ClientError.unreadable }
		switch effects.status {
		case "adopted":
			guard let stamp = effects.cases.first(where: { $0.ref == submission.ref }) else { throw ClientError.unreadable }
			return .adopted(CaseStamp(ref: stamp.ref, version: stamp.version))
		case "unchanged": return .unchanged
		case "open":
			guard let question = effects.adopt else { throw ClientError.unreadable }
			return .waiting(question)
		case "conflict":
			guard let question = effects.adopt else { throw ClientError.unreadable }
			return .moved(question)
		default: throw ClientError.unreadable
		}
	}
}
