import Foundation
import JavaScriptCore

/// A merge made on the documents the person saw, with no network or view state of its own.
public struct CaseConflict: Equatable, Sendable {
	public let question: String
	public let evidence: String
	public let ref: String
	public let current: CaseContent
	public let mine: CaseContent
	public private(set) var merged: CaseContent
	public let paths: [String]
	public private(set) var selections: [String: Side] = [:]
	public var chosen: Set<String> { Set(selections.keys) }

	package init(question: String, evidence: String, ref: String, base: CaseContent,
		mine: CaseContent, current: CaseContent) throws {
		self.question = question; self.evidence = evidence; self.ref = ref
		self.current = current; self.mine = mine
		guard let context = JSContext() else { throw ClientError.unreadable }
		context.evaluateScript(MergeRuntime.source)
		let input: JSONValue = ["base": base.json, "mine": mine.json, "theirs": current.json]
		let data = try JSONEncoder().encode(input)
		guard let text = String(data: data, encoding: .utf8),
			let result = context.objectForKeyedSubscript("mergeCase")?.call(withArguments: [text])?.toString(),
			context.exception == nil else { throw ClientError.unreadable }
		struct Result: Decodable {
			struct Conflict: Decodable { let path: String }
			let merged: Wire.CaseBody
			let conflicts: [Conflict]
		}
		let decoded = try JSONDecoder().decode(Result.self, from: Data(result.utf8))
		merged = CaseContent(decoded.merged)
		paths = decoded.conflicts.map(\.path)
	}

	public var complete: Bool { Set(paths).isSubset(of: chosen) }
	public enum Side: Equatable, Sendable { case mine, current }

	public mutating func choose(_ path: String, side: Side) {
		guard paths.contains(path) else { return }
		let body = side == .mine ? mine : current
		switch path {
		case "title": merged.title = body.title
		case "pre": merged.pre = body.pre
		case "methods": merged.methods = body.methods
		case "automate": merged.automate = body.automate
		case "steps.order":
			let ordered = body.steps.compactMap { step in merged.steps.first { $0.id == step.id } }
			let ids = Set(ordered.map(\.id))
			merged.steps = ordered + merged.steps.filter { !ids.contains($0.id) }
		default:
			if path.hasPrefix("fields.") {
				let key = String(path.dropFirst(7))
				merged.fields[key] = body.fields[key]
			} else {
				let parts = path.split(separator: ".").map(String.init)
				guard parts.count >= 2, parts[0] == "steps" else { return }
				let id = parts[1]
				let step = body.steps.first { $0.id == id }
				if parts.count == 2 {
					if let step {
						if let index = merged.steps.firstIndex(where: { $0.id == id }) { merged.steps[index] = step }
						else {
							let following = body.steps.drop(while: { $0.id != id }).dropFirst()
								.compactMap { item in merged.steps.firstIndex { $0.id == item.id } }.first
							let preceding = body.steps.prefix(while: { $0.id != id }).reversed()
								.compactMap { item in merged.steps.firstIndex { $0.id == item.id } }.first
							merged.steps.insert(step, at: following ?? preceding.map { $0 + 1 } ?? merged.steps.count)
						}
					} else { merged.steps.removeAll { $0.id == id } }
				} else if let index = merged.steps.firstIndex(where: { $0.id == id }), let step {
					if parts[2] == "action" { merged.steps[index].action = step.action }
					else if parts[2] == "expected" { merged.steps[index].expected = step.expected }
					else { return }
				} else { return }
			}
		}
		selections[path] = side
		if path != "steps.order", let order = selections["steps.order"] { choose("steps.order", side: order) }
	}

	public func label(_ path: String) -> String {
		switch path {
		case "title": return "Title"
		case "pre": return "Preconditions"
		case "methods": return "Methods"
		case "automate": return "Automation"
		case "steps.order": return "Step order"
		default:
			if path.hasPrefix("fields.") { return "Field: " + path.dropFirst(7) }
			let parts = path.split(separator: ".").map(String.init)
			guard parts.count >= 2,
				let index = mine.steps.firstIndex(where: { $0.id == parts[1] })
					?? current.steps.firstIndex(where: { $0.id == parts[1] }) else { return path }
			let part = parts.count == 2 ? "" : parts[2] == "action" ? " action" : " expected result"
			return "Step \(index + 1)\(part)"
		}
	}

	public func text(_ path: String, side: Side) -> String {
		let body = side == .mine ? mine : current
		switch path {
		case "title": return body.title
		case "pre": return body.pre.isEmpty ? "No preconditions" : body.pre
		case "methods": return body.methods.joined(separator: ", ")
		case "automate": return body.automate
		case "steps.order": return body.steps.map { "\($0.id): \($0.action)" }.joined(separator: "\n")
		default:
			if path.hasPrefix("fields.") { return body.fields[String(path.dropFirst(7))] ?? "Field removed" }
			let parts = path.split(separator: ".").map(String.init)
			guard parts.count >= 2, let step = body.steps.first(where: { $0.id == parts[1] }) else { return "Step removed" }
			if parts.count == 2 { return step.action + (step.expected.map { "\nExpected: \($0)" } ?? "") }
			return parts[2] == "action" ? step.action : step.expected ?? "No expected result"
		}
	}
}

extension CaseContent {
	package var json: JSONValue { [
		"title": .string(title), "pre": .string(pre), "methods": .array(methods.map(JSONValue.string)),
		"automate": .string(automate), "fields": .object(fields.mapValues(JSONValue.string)),
		"steps": .array(steps.map { ["id": .string($0.id), "action": .string($0.action),
			"expected": $0.expected.map(JSONValue.string) ?? .null] }),
	] }
}

package struct MergeSubmission: Sendable {
	let input: JSONValue
	let ref: String
	let command = UUID().uuidString.lowercased()
	package init(_ conflict: CaseConflict) {
		ref = conflict.ref
		input = ["q": .string(conflict.question), "onEvidence": .string(conflict.evidence),
			"answer": ["is": "merge", "body": conflict.merged.json], "cmd": .string(command)]
	}
}

package enum MergeOutcome: Sendable {
	case adopted(CaseStamp), unchanged, waiting(String), moved(String), refused(String)
}

extension ProjectClient {
	package func conflict(_ question: String, ref: String) async throws -> CaseConflict {
		let questions: [Wire.Question] = try await server.read("get", in: key, ["refs": [.string(question)]])
		guard let q = questions.first, q.q == question, q.kind == "adopt", q.state == "open",
			let evidence = q.evidence.read(as: Wire.AdoptEvidence.self), !evidence.conflicts.isEmpty else {
			throw ClientError.refused(code: "conflict", message: "This conflict is no longer open. Your draft and choices are kept.")
		}
		let rows: [Wire.ConflictProposal] = try await server.read("get", in: key, ["refs": [.string(evidence.proposal)]])
		guard let row = rows.first, row.ref == evidence.proposal, row.edits.count == 1,
			let edit = row.edits.first, edit.op == "edit", edit.case == ref else { throw ClientError.unreadable }
		var base = try await caseDocument(ref, version: edit.base).content
		// A case read alone omits custom fields. A history comparison includes all of them, even when
		// unchanged. Reading the base against itself supplies the exact values without guessing.
		let fields: Wire.ConflictBaseFields = try await server.read("history", in: key,
			["ref": .string(ref), "from": .number(Double(edit.base)), "to": .number(Double(edit.base))])
		guard fields.ref == ref, fields.from == edit.base, fields.to == edit.base else { throw ClientError.unreadable }
		base.fields = fields.diff.fields.before
		return try CaseConflict(question: question, evidence: q.evidenceHash, ref: ref, base: base,
			mine: CaseContent(edit.mine), current: CaseContent(edit.current))
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
		guard reply.status == "decided" else { return .refused(reply.needs ?? "The merge was not adopted (\(reply.status)). Your choices are kept.") }
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
