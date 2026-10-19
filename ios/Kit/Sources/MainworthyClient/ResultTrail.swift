import Foundation

public enum ResultOutcome: String, Decodable, Equatable, Sendable {
	case pass, fail, skip, blocked, error
}

/// A step's identifier stays opaque: it can name a fragment occurrence or be a runner's label.
public struct ResultStep: Equatable, Sendable {
	public struct Action: Equatable, Sendable {
		public let text: String
		public let outcome: ResultOutcome?
		public let durationMs: Int?

		init(_ wire: Wire.ResultAction) {
			text = wire.text
			outcome = wire.outcome
			durationMs = wire.durationMs
		}
	}

	public let step: String
	public let outcome: ResultOutcome
	public let durationMs: Int?
	public let actions: [Action]?
	/// Zero-based position in this result's attachments, in the server's order.
	public let attachment: Int?

	init(_ wire: Wire.ResultStep) {
		step = wire.step
		outcome = wire.outcome
		durationMs = wire.durationMs
		actions = wire.actions?.map(Action.init)
		attachment = wire.attachment
	}

	/// Missing and zero durations have no heat. Equal durations have equal heat.
	public func heat(in steps: [ResultStep]) -> Double {
		let maximum = steps.compactMap(\.durationMs).max() ?? 0
		guard let durationMs, maximum > 0 else { return 0 }
		return Double(durationMs) / Double(maximum)
	}
}

public struct ResultScreenshot: Equatable, Sendable {
	public let name: String
	public let type: String
	public let data: Data
}

extension ProjectClient {
	/// Resolve the trail's index using the ordered list, then read that file from the same result.
	package func screenshot(result: Int, index: Int) async throws -> ResultScreenshot {
		let list: Wire.AttachmentList = try await server.read("attachment", in: key, ["result": .number(Double(result))])
		guard list.kind == "list", list.items.indices.contains(index) else { throw ClientError.unreadable }
		let selected = list.items[index]
		guard selected.result == result else { throw ClientError.unreadable }
		let file: Wire.AttachmentFile = try await server.read("attachment", in: key, [
			"result": .number(Double(result)), "id": .number(Double(selected.id)),
		])
		guard file.kind == "file", file.attachment == selected, let data = Data(base64Encoded: file.data) else {
			throw ClientError.unreadable
		}
		return ResultScreenshot(name: selected.name, type: selected.type, data: data)
	}
}
