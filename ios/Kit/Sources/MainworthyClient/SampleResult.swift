import Foundation

public struct SampleResult: Equatable, Sendable {
	public let id: Int
	public let detail: String?
	public let note: String?
	public let steps: [ResultStep]?
	public let build: URL?
	/// File names in the server's order, including files no step points to.
	public let attachments: [String]

	public var hasContent: Bool {
		!(detail ?? "").isEmpty || !(note ?? "").isEmpty || build != nil
			|| !(steps ?? []).isEmpty || !attachments.isEmpty
	}
}

extension ProjectClient {
	package func sampleResult(_ id: Int) async throws -> SampleResult {
		let ref = "result:\(id)"
		let rows: [Wire.SampleResult] = try await server.read("get", in: key, ["refs": [.string(ref)]])
		guard rows.count == 1, let wire = rows.first, wire.ref == ref, wire.id == id else {
			throw ClientError.unreadable
		}
		let files: Wire.AttachmentList = try await server.read("attachment", in: key, ["result": .number(Double(id))])
		guard files.kind == "list", files.items.allSatisfy({ $0.result == id }) else { throw ClientError.unreadable }
		return SampleResult(
			id: wire.id, detail: wire.detail, note: wire.note, steps: wire.steps?.map(ResultStep.init),
			build: webAddress(wire.build), attachments: files.items.map(\.name)
		)
	}
}
