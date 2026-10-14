import Foundation

public enum SessionProof: Equatable, Sendable {
	case password, token, passkey
	case other(String)

	init(_ word: String) {
		switch word {
		case "password": self = .password
		case "token": self = .token
		case "passkey": self = .passkey
		default: self = .other(word)
		}
	}

	public var name: String {
		switch self {
		case .password: "password"
		case .token: "token"
		case .passkey: "passkey"
		case .other(let word): word
		}
	}
}

public struct PersonSession: Identifiable, Equatable, Sendable {
	public let id: Int
	public let proof: SessionProof
	public let label: String
	public let client: String
	public let openedAt: Date
	public let openedFrom: String?
	public let lastUsedAt: Date
	public let lastUsedFrom: String?
	public let expiresAt: Date
	public let current: Bool

	init(_ wire: Wire.SessionRow) {
		id = wire.id
		proof = SessionProof(wire.openedWith)
		label = wire.label
		client = browserName(wire.userAgent)
		openedAt = Date(milliseconds: wire.createdAt)
		openedFrom = wire.createdFrom
		lastUsedAt = Date(milliseconds: wire.lastUsedAt)
		lastUsedFrom = wire.lastUsedFrom
		expiresAt = Date(milliseconds: wire.expiresAt)
		current = wire.current
	}
}

/// A short name from the client's unverified user agent, with the same precedence as the web app.
public func browserName(_ userAgent: String?) -> String {
	let text = userAgent?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
	guard !text.isEmpty else { return "Unknown browser" }
	let browsers = [
		(#"\bEdg(?:e|A|iOS)?/"#, "Edge"), (#"\bOPR/"#, "Opera"),
		(#"\bFirefox/|\bFxiOS/"#, "Firefox"), (#"\b(?:Headless)?Chrome/|\bCriOS/"#, "Chrome"),
		(#"\bVersion/[\d.]+.*\bSafari/"#, "Safari"),
	]
	let systems = [
		(#"\bAndroid\b"#, "Android"), (#"\biPhone\b|\biPad\b|\biPod\b"#, "iOS"),
		(#"\bWindows\b"#, "Windows"), (#"\bCrOS\b"#, "ChromeOS"),
		(#"\bMac OS X\b|\bMacintosh\b"#, "macOS"), (#"\bLinux\b"#, "Linux"),
	]
	if let browser = browsers.first(where: { text.range(of: $0.0, options: .regularExpression) != nil })?.1 {
		if let system = systems.first(where: { text.range(of: $0.0, options: .regularExpression) != nil })?.1 {
			return "\(browser) on \(system)"
		}
		return browser
	}
	let points = text.unicodeScalars
	return points.count > 60 ? String(String.UnicodeScalarView(points.prefix(60))) + "…" : text
}

public enum SessionEndOutcome: Equatable, Sendable {
	case ended, signedOut, alreadyEnded, notEnded
}

extension Server {
	package func sessions() async throws -> [PersonSession] {
		// The operation records session use even when listing, so it takes a command id.
		let wire: [Wire.SessionRow] = try await write("session", in: nil, ["do": "list"])
		return wire.map(PersonSession.init)
	}

	package func end(_ session: PersonSession) async throws -> SessionEndOutcome {
		do {
			let wire: Wire.SessionEnd = try await write("session", in: nil, ["do": "end", "id": .number(Double(session.id))])
			guard wire.ended else { return .notEnded }
			return wire.current ? .signedOut : .ended
		} catch ClientError.refused(let code, _) where code == "not_found" {
			return .alreadyEnded
		}
	}
}
