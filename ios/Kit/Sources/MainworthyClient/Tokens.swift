import Foundation

public struct AccessToken: Identifiable, Equatable, Sendable {
	public enum State: String, Sendable { case active = "Active", expired = "Expired", revoked = "Revoked" }
	public let id: Int
	public let actor: String
	public let kind: String
	public let label: String
	public let createdAt: Date
	public let createdBy: String?
	public let expiresAt: Date?
	public let lastUsedAt: Date?
	public let lastUsedFrom: String?
	public let state: State

	public var name: String { "\"\(label.isEmpty ? "Untitled token" : label)\" (#\(id))" }

	init(_ wire: Wire.TokenRow) {
		id = wire.id
		actor = wire.actor
		kind = wire.kind
		label = wire.label
		createdAt = Date(milliseconds: wire.createdAt)
		createdBy = wire.createdBy
		expiresAt = wire.expiresAt.map { Date(milliseconds: $0) }
		lastUsedAt = wire.lastUsedAt.map { Date(milliseconds: $0) }
		lastUsedFrom = wire.lastUsedFrom
		state = wire.revoked ? .revoked : wire.expired ? .expired : .active
	}
}

/// Kept across a lost reply. Replaying its command returns the original result without another revocation.
package struct TokenRevocation: Sendable {
	package let token: AccessToken
	let input: JSONValue
	package init(_ token: AccessToken) {
		self.token = token
		input = ["do": "token.revoke", "id": .number(Double(token.id)), "cmd": .string(UUID().uuidString.lowercased())]
	}
}

extension Server {
	package func tokens() async throws -> [AccessToken] {
		let rows: [Wire.TokenRow] = try await read("admin", in: nil, ["do": "token.list"])
		return rows.map(AccessToken.init)
	}

	package func revoke(_ submission: TokenRevocation) async throws -> Bool {
		// Instance commands cannot be read through the project's command operation. Replay the saved id.
		let reply: Wire.TokenRevoke = try await read("admin", in: nil, submission.input, attempts: 1)
		return reply.revoked
	}
}
