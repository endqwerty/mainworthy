import Foundation

/// Any JSON value. A request is written as one, and a part of a reply that the app passes on or reads by hand
/// (a question's evidence, which depends on its kind) arrives as one.
public enum JSONValue: Hashable, Sendable {
	case null
	case bool(Bool)
	case number(Double)
	case string(String)
	case array([JSONValue])
	case object([String: JSONValue])

	public var string: String? {
		if case .string(let value) = self { value } else { nil }
	}

	public var number: Double? {
		if case .number(let value) = self { value } else { nil }
	}

	public var bool: Bool? {
		if case .bool(let value) = self { value } else { nil }
	}

	public var array: [JSONValue]? {
		if case .array(let value) = self { value } else { nil }
	}

	public var object: [String: JSONValue]? {
		if case .object(let value) = self { value } else { nil }
	}

	public subscript(key: String) -> JSONValue? {
		object?[key]
	}

	/// Reads this value as a type that decodes from JSON, or nil when it is not one.
	func read<T: Decodable>(as type: T.Type) -> T? {
		guard let data = try? JSONEncoder().encode(self) else { return nil }
		return try? JSONDecoder().decode(type, from: data)
	}
}

extension JSONValue: Codable {
	public init(from decoder: any Decoder) throws {
		let container = try decoder.singleValueContainer()
		if container.decodeNil() {
			self = .null
		} else if let value = try? container.decode(Bool.self) {
			self = .bool(value)
		} else if let value = try? container.decode(Double.self) {
			self = .number(value)
		} else if let value = try? container.decode(String.self) {
			self = .string(value)
		} else if let value = try? container.decode([JSONValue].self) {
			self = .array(value)
		} else {
			self = .object(try container.decode([String: JSONValue].self))
		}
	}

	public func encode(to encoder: any Encoder) throws {
		var container = encoder.singleValueContainer()
		switch self {
		case .null: try container.encodeNil()
		case .bool(let value): try container.encode(value)
		// A whole number is written as one: the server refuses `100.0` where it asks for an integer.
		case .number(let value):
			if let whole = Int(exactly: value) { try container.encode(whole) } else { try container.encode(value) }
		case .string(let value): try container.encode(value)
		case .array(let value): try container.encode(value)
		case .object(let value): try container.encode(value)
		}
	}
}

extension JSONValue: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral,
	ExpressibleByFloatLiteral, ExpressibleByStringLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral
{
	public init(nilLiteral: ()) { self = .null }
	public init(booleanLiteral value: Bool) { self = .bool(value) }
	public init(integerLiteral value: Int) { self = .number(Double(value)) }
	public init(floatLiteral value: Double) { self = .number(value) }
	public init(stringLiteral value: String) { self = .string(value) }
	public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
	public init(dictionaryLiteral elements: (String, JSONValue)...) {
		self = .object(Dictionary(elements, uniquingKeysWith: { _, last in last }))
	}
}
