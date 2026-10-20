import Foundation

public struct SuiteCase: Identifiable, Equatable, Sendable {
	public var id: String { ref }
	public let ref: String
	public let title: String
	public let tags: [String]
	public let proof: [CaseProof]

	init(_ wire: Wire.SuiteCase) {
		ref = wire.ref
		title = wire.title
		tags = wire.tags
		proof = [("human", wire.proof.human), ("auto", wire.proof.auto), ("agent", wire.proof.agent)]
			.compactMap { method, proof in proof.map { CaseProof(method: method, wire: $0) } }
	}
}

public struct CaseProof: Equatable, Sendable {
	public enum Outcome: Equatable, Sendable {
		case pass, fail, skip, blocked, error, other(String)
		public var word: String {
			switch self {
			case .pass: "pass"
			case .fail: "fail"
			case .skip: "skip"
			case .blocked: "blocked"
			case .error: "error"
			case .other(let word): word
			}
		}
	}
	public let method: String
	public let outcome: Outcome
	public let current: Bool

	init(method: String, wire: Wire.SuiteProof) {
		self.method = method
		current = wire.current
		outcome = switch wire.outcome {
		case "pass": .pass
		case "fail": .fail
		case "skip": .skip
		case "blocked": .blocked
		case "error": .error
		default: .other(wire.outcome)
		}
	}
}

public struct SuiteFolder: Identifiable, Hashable, Sendable {
	public let id: Int
	public let parent: Int?
	public let name: String
	public let path: String
	public let cases: Int
	public let state: String

	init(_ wire: Wire.SuiteFolder) {
		id = wire.id
		parent = wire.parent
		name = wire.name
		path = wire.path
		cases = wire.cases
		state = wire.state
	}
}

public struct SuiteTag: Identifiable, Equatable, Sendable {
	public var id: String { name }
	public let name: String
	public let count: Int
	init(_ wire: Wire.SuiteTag) { name = wire.tag; count = wire.n }
}

public struct CaseDocument: Equatable, Sendable {
	public let ref: String
	public let version: Int
	public let isHistorical: Bool
	public let hasSharedSteps: Bool
	public let content: CaseContent
	public let tags: [String]
	/// Placement is current even when the document is an older version.
	public let folder: String
	/// Nil means the server did not expose the fields. An edit then omits them to keep the base's values.
	let readFields: [String: String]?

	init(_ wire: Wire.SuiteDocument, isHistorical: Bool = false) {
		self.isHistorical = isHistorical
		hasSharedSteps = wire.kind == "fragment" || wire.hasFragments == true
		ref = wire.ref
		version = wire.version
		content = CaseContent(
			title: wire.title, pre: wire.pre, steps: wire.steps.map(Step.init), methods: wire.methods,
			automate: wire.automate, fields: wire.fields ?? [:]
		)
		tags = wire.tags
		folder = wire.folder.path
		readFields = wire.fields
	}
}

public struct CaseVersion: Identifiable, Equatable, Sendable {
	public var id: Int { version }
	public let version: Int
	public let by: String
	public let at: Date
	public let reason: String?
	public let summary: String

	init(_ wire: Wire.SuiteVersion) {
		version = wire.version
		by = wire.by
		at = Date(timeIntervalSince1970: wire.at / 1000)
		reason = wire.reason
		summary = wire.summary
	}
}

public enum CaseSource: Equatable, Sendable {
	case create(folder: String?)
	case edit(CaseDocument)
}

public struct CaseStamp: Equatable, Sendable {
	public let ref: String
	public let version: Int
	package init(ref: String, version: Int) { self.ref = ref; self.version = version }
}

public enum SaveCaseOutcome: Equatable, Sendable {
	case adopted(CaseStamp?)
	case waiting(question: String?, needs: String?)
	case overlap(question: String?, addresses: [ConflictAddress], sentence: String?)
	case notTaken(String)
}

package struct SuiteSubmission: Sendable {
	let input: JSONValue
	package let delivery = WriteDelivery()

	package init(source: CaseSource, content: CaseContent, reason: String) {
		var body: [String: JSONValue] = [
			"title": .string(content.title), "pre": .string(content.pre),
			"steps": .array(content.steps.map(\.json)),
			"methods": .array(content.methods.map(JSONValue.string)), "automate": .string(content.automate),
		]
		var edit: [String: JSONValue]
		switch source {
		case .create(let folder):
			body["fields"] = .object(content.fields.mapValues(JSONValue.string))
			edit = ["op": "create", "body": .object(body)]
			if let folder { edit["folder"] = .string(folder) }
		case .edit(let opened):
			if let fields = opened.readFields { body["fields"] = .object(fields.mapValues(JSONValue.string)) }
			edit = ["op": "edit", "case": .string(opened.ref), "base": .number(Double(opened.version)), "body": .object(body)]
		}
		var input: [String: JSONValue] = ["edits": [.object(edit)], "cmd": .string(UUID().uuidString.lowercased())]
		if !reason.isEmpty { input["reason"] = .string(reason) }
		self.input = .object(input)
	}
}

extension ProjectClient {
	package func cases(folder: String? = nil, deep: Bool = false, text: String = "", tag: String? = nil,
		after: String? = nil, limit: Int = 100
	) async throws -> (items: [SuiteCase], next: String?) {
		var input: [String: JSONValue] = ["in": "cases", "limit": .number(Double(limit))]
		if let folder { input["folder"] = .string(folder) }
		if deep, folder != nil { input["deep"] = true }
		if !text.isEmpty { input["text"] = .string(text) }
		if let tag { input["tags"] = [.string(tag)] }
		if let after { input["cursor"] = .string(after) }
		let reply: Wire.SuiteCases = try await server.read("find", in: key, .object(input))
		return (reply.items.map(SuiteCase.init), reply.cursor)
	}

	package func folders() async throws -> [SuiteFolder] {
		let reply: Wire.SuiteFolders = try await server.read("find", in: key, ["in": "folders"])
		return reply.items.map(SuiteFolder.init).filter { $0.state == "active" }
	}

	package func tags() async throws -> [SuiteTag] {
		let reply: Wire.SuiteTags = try await server.read("find", in: key, ["in": "tags"])
		return reply.items.map(SuiteTag.init)
	}

	package func caseDocument(_ ref: String, version: Int? = nil) async throws -> CaseDocument {
		var input: [String: JSONValue] = ["refs": [.string(ref)]]
		if let version { input["version"] = .number(Double(version)) }
		let reply: [Wire.SuiteDocument] = try await server.read("get", in: key, .object(input))
		guard let found = reply.first, found.ref == ref, version == nil || found.version == version else {
			throw ClientError.unreadable
		}
		return CaseDocument(found, isHistorical: version != nil)
	}

	package func caseHistory(_ ref: String) async throws -> [CaseVersion] {
		let reply: Wire.SuiteHistory = try await server.read("history", in: key, ["ref": .string(ref)])
		return reply.versions.map(CaseVersion.init)
	}

	/// Get does not expose usedStepIds, so collect every version's ids before adding a step to an edit.
	package func usedStepIds(of document: CaseDocument) async throws -> Set<String> {
		var ids = Set(document.content.steps.map(\.id))
		for version in try await caseHistory(document.ref) where version.version != document.version {
			let older = try await caseDocument(document.ref, version: version.version)
			ids.formUnion(older.content.steps.map(\.id))
		}
		return ids
	}

	/// The submission keeps its command and body across retries. Server.write makes a new id, so use the
	/// exchange that leaves this already named command intact, including on its own connection retry.
	package func saveCase(_ submission: SuiteSubmission) async throws -> SaveCaseOutcome {
		let reply: Wire.SuiteProposeReply = try await server.read("propose", in: key, submission.input, delivery: submission.delivery)
		switch reply.status {
		case "adopted":
			return .adopted(reply.cases.first.map { CaseStamp(ref: $0.ref, version: $0.version) })
		case "open": return .waiting(question: reply.question, needs: reply.needs)
		case "conflict":
			return .overlap(question: reply.question, addresses: reply.conflicts.flatMap(\.addresses), sentence: reply.needs)
		default: return .notTaken(reply.needs ?? "The proposal was \(reply.status).")
		}
	}
}
