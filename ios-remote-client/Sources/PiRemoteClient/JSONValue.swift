import Foundation

public struct JSONObjectMember: Equatable, Sendable {
  public let key: String
  public let value: JSONValue

  public init(_ key: String, _ value: JSONValue) {
    self.key = key
    self.value = value
  }
}

public enum JSONValue: Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([JSONObjectMember])
  case rawJSON(String)

  public func jsonString() throws -> String {
    switch self {
    case .null:
      "null"
    case .bool(let value):
      value ? "true" : "false"
    case .number(let value):
      try encodeNumber(value)
    case .string(let value):
      try encodeJSONString(value)
    case .array(let values):
      try "[" + values.map { try $0.jsonString() }.joined(separator: ",") + "]"
    case .object(let members):
      try encodeObject(members)
    case .rawJSON(let json):
      json
    }
  }
}

extension JSONValue: ExpressibleByStringLiteral {
  public init(stringLiteral value: String) {
    self = .string(value)
  }
}

extension JSONValue: ExpressibleByBooleanLiteral {
  public init(booleanLiteral value: Bool) {
    self = .bool(value)
  }
}

extension JSONValue: ExpressibleByArrayLiteral {
  public init(arrayLiteral elements: JSONValue...) {
    self = .array(elements)
  }
}

extension JSONValue: ExpressibleByDictionaryLiteral {
  public init(dictionaryLiteral elements: (String, JSONValue)...) {
    self = .object(elements.map { JSONObjectMember($0.0, $0.1) })
  }
}

private func encodeObject(_ members: [JSONObjectMember]) throws -> String {
  let encodedMembers = try members.map { member in
    "\(try encodeJSONString(member.key)):\(try member.value.jsonString())"
  }
  return "{" + encodedMembers.joined(separator: ",") + "}"
}

private func encodeNumber(_ value: Double) throws -> String {
  if value.rounded(.towardZero) == value {
    return String(Int(value))
  }
  return String(value)
}

private func encodeJSONString(_ value: String) throws -> String {
  var encoded = "\""
  for scalar in value.unicodeScalars {
    encoded += escapedJSONScalar(scalar)
  }
  encoded += "\""
  return encoded
}

private func escapedJSONScalar(_ scalar: UnicodeScalar) -> String {
  switch scalar {
  case "\"":
    "\\\""
  case "\\":
    "\\\\"
  case "\n":
    "\\n"
  case "\r":
    "\\r"
  case "\t":
    "\\t"
  case "\u{08}":
    "\\b"
  case "\u{0C}":
    "\\f"
  case "\u{00}"..."\u{1F}":
    "\\u" + String(format: "%04X", scalar.value).lowercased()
  default:
    String(scalar)
  }
}

