import Foundation

/// Where a Mainworthy is: the address a person types, made into the address requests go to.
public struct Instance: Hashable, Sendable, Codable {
	/// The scheme, host and port, with no path: `https://mainworthy.example`.
	public let url: URL

	/// Reads what a person typed. A pasted page address loses its path; an address with no scheme gets `https`,
	/// or `http` when it names this device's own network, which is the one place iOS lets plain http through.
	/// Nil when the text names no host.
	public init?(address: String) {
		let text = address.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !text.isEmpty, !text.contains(" ") else { return nil }
		let hasScheme = text.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*://"#, options: .regularExpression) != nil
		guard let typed = URLComponents(string: hasScheme ? text : "placeholder://\(text)"),
			// An IPv6 address is written between brackets in an address, and without them everywhere else.
			let host = typed.host?.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]")), !host.isEmpty
		else { return nil }
		let scheme = hasScheme ? typed.scheme?.lowercased() : (Instance.isLocal(host) ? "http" : "https")
		guard scheme == "http" || scheme == "https" else { return nil }
		var origin = URLComponents()
		origin.scheme = scheme
		origin.host = host.contains(":") ? "[\(host)]" : host
		origin.port = typed.port
		guard let url = origin.url else { return nil }
		self.url = url
	}

	/// The address as a person recognises it and can type it again: `mainworthy.example`, `192.168.1.20:7357`.
	/// The scheme is left out where the address reads back to this instance without it, and kept where it would
	/// not: `https://printer.local:7357`.
	public var name: String {
		let bare = String(url.absoluteString.trimmingPrefix(/https?:\/\//))
		return Instance(address: bare) == self ? bare : url.absoluteString
	}

	/// Whether a host is on this device's own network: itself, a private IPv4 address, or a `.local` name.
	static func isLocal(_ host: String) -> Bool {
		if host == "localhost" || host == "::1" || host.hasSuffix(".local") { return true }
		let parts = host.split(separator: ".").compactMap { UInt8($0) }
		guard parts.count == 4, host.split(separator: ".").count == 4 else { return false }
		return parts[0] == 127 || parts[0] == 10 || (parts[0] == 192 && parts[1] == 168)
			|| (parts[0] == 172 && (16...31).contains(parts[1]))
	}
}
