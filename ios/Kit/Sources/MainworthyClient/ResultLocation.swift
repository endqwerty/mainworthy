import Foundation

/// The server's recorded branch and change for a result, with the exact commit kept separately.
public struct ResultLocation: Equatable, Sendable {
	public let label: String
	public let commit: String?
	public let change: String?
	init(_ wire: Wire.ResultLocation) {
		label = wire.label
		commit = wire.commit
		change = wire.change
	}
}
