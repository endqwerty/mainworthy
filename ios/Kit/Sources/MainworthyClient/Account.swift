import Foundation

/// Who is signed in, and what they may open.
public struct Account: Equatable, Sendable {
	public let name: String
	package let actorId: Int
	public let isOwner: Bool
	/// The version of the server, for the About screen.
	public let serverVersion: String
	/// The projects the person may read. One they hold a grant on and may not read is not a screen's to show.
	public let projects: [Project]

	init(_ wire: Wire.SessionInfo) {
		name = wire.actor
		actorId = wire.actorId
		isOwner = wire.owner
		serverVersion = wire.version
		projects = wire.projects.map(Project.init).filter { $0.may(.read) }
	}

	public init(name: String, actorId: Int = 0, isOwner: Bool = false, serverVersion: String = "", projects: [Project]) {
		self.name = name
		self.actorId = actorId
		self.isOwner = isOwner
		self.serverVersion = serverVersion
		self.projects = projects
	}
}

/// What a grant lets its holder do in a project, in the server's words.
public enum Capability: String, Sendable {
	case read, record, produce, answer, plan, admin
}

public struct Project: Identifiable, Hashable, Sendable {
	public var id: String { key }
	/// The short name in addresses: `scratch`.
	public let key: String
	public let name: String
	/// The policy's preset: loose, standard, strict or custom.
	public let policy: String
	private let can: Set<String>

	init(_ wire: Wire.Project) {
		self.init(key: wire.key, name: wire.name, policy: wire.policy, can: wire.can)
	}

	public init(key: String, name: String, policy: String = "loose", can: [String] = ["read"]) {
		self.key = key
		self.name = name
		self.policy = policy
		self.can = Set(can)
	}

	/// Whether the person may do this here. A screen asks before it offers an action the server would refuse.
	public func may(_ capability: Capability) -> Bool {
		can.contains(capability.rawValue)
	}
}

/// Something changed in a project. It says too little to apply: whoever hears it reads again what they show.
public struct Change: Equatable, Sendable {
	/// The operation that ran: `decide`, `report`, `propose`.
	public let operation: String
	/// The refs it touched. Empty does not mean nothing changed.
	public let touched: [String]

	/// What a change stream says first: it is open, and whatever changes from now on will be heard. Whoever
	/// follows the stream reads what they show at this point, and not before.
	package static let opened = Change(operation: "", touched: [])
}

extension Date {
	/// A moment as the server writes one: milliseconds since 1970.
	init(milliseconds: Double) {
		self.init(timeIntervalSince1970: milliseconds / 1000)
	}
}
