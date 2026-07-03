import Foundation

public let remoteControlALPN = "pi/remote/1"

public enum ControlMessageType: String, Equatable, Sendable {
  case pair
  case list
  case attach
  case detach
  case sessionEnded = "session_ended"
}

public enum PerSessionMessageType: String, Equatable, Sendable {
  case event
  case prompt
  case abort
}

public struct ControlEnvelope: Equatable, Sendable {
  public let type: ControlMessageType
  public let payload: JSONValue

  public init(type: ControlMessageType, payload: JSONValue) {
    self.type = type
    self.payload = payload
  }
}

public struct PerSessionEnvelope: Equatable, Sendable {
  public let sessionID: String
  public let type: PerSessionMessageType
  public let payload: JSONValue

  public init(sessionID: String, type: PerSessionMessageType, payload: JSONValue) {
    self.sessionID = sessionID
    self.type = type
    self.payload = payload
  }
}

public enum Envelope: Equatable, Sendable {
  case control(ControlEnvelope)
  case session(PerSessionEnvelope)

  public var sessionID: String? {
    switch self {
    case .control:
      nil
    case .session(let envelope):
      envelope.sessionID
    }
  }

  public var type: String {
    switch self {
    case .control(let envelope):
      envelope.type.rawValue
    case .session(let envelope):
      envelope.type.rawValue
    }
  }

  public var payload: JSONValue {
    switch self {
    case .control(let envelope):
      envelope.payload
    case .session(let envelope):
      envelope.payload
    }
  }
}

public enum RemoteProtocolError: Error, Equatable {
  case invalidUTF8Frame
  case missingRawPayload
  case unknownControlMessageType(String)
  case unknownPerSessionMessageType(String)
}

public func encodeFrame(_ envelope: Envelope) throws -> Data {
  Data((try envelope.jsonString() + "\n").utf8)
}

public func decodeFrame(_ frame: String) throws -> Envelope {
  try decodeFrame(Data(frame.utf8))
}

public func decodeFrame(_ frame: Data) throws -> Envelope {
  var bytes = frame
  if bytes.last == 0x0A {
    bytes.removeLast()
  }
  guard let json = String(data: bytes, encoding: .utf8) else {
    throw RemoteProtocolError.invalidUTF8Frame
  }
  let wire = try JSONDecoder().decode(WireEnvelope.self, from: Data(json.utf8))
  let payload = try JSONValue.rawJSON(extractRawPayload(from: json))
  return try Envelope.from(sessionID: wire.sessionId, type: wire.type, payload: payload)
}

public func decodeFrames(_ input: String) throws -> [Envelope] {
  try decodeFrames(Data(input.utf8))
}

public func decodeFrames(_ input: Data) throws -> [Envelope] {
  var frames: [Envelope] = []
  var decoder = StreamingFrameDecoder()
  frames.append(contentsOf: try decoder.append(input))
  frames.append(contentsOf: try decoder.finish())
  return frames
}

public struct StreamingFrameDecoder: Sendable {
  private var buffered = Data()

  public init() {}

  public mutating func append(_ chunk: Data) throws -> [Envelope] {
    buffered.append(chunk)
    return try drainCompleteFrames()
  }

  public mutating func finish() throws -> [Envelope] {
    defer { buffered.removeAll() }
    guard !buffered.isEmpty else {
      return []
    }
    return [try decodeFrame(buffered)]
  }

  private mutating func drainCompleteFrames() throws -> [Envelope] {
    var frames: [Envelope] = []
    while let newline = buffered.firstIndex(of: 0x0A) {
      if buffered.startIndex < newline {
        try frames.append(decodeFrame(buffered[buffered.startIndex..<newline]))
      }
      buffered.removeSubrange(buffered.startIndex...newline)
    }
    return frames
  }
}

private struct WireEnvelope: Decodable {
  let sessionId: String?
  let type: String
}

private extension Envelope {
  static func from(sessionID: String?, type: String, payload: JSONValue) throws -> Envelope {
    if let sessionID {
      return try Envelope(sessionID: sessionID, type: type, payload: payload)
    }
    return try Envelope(controlType: type, payload: payload)
  }

  init(controlType: String, payload: JSONValue) throws {
    guard let type = ControlMessageType(rawValue: controlType) else {
      throw RemoteProtocolError.unknownControlMessageType(controlType)
    }
    self = .control(.init(type: type, payload: payload))
  }

  init(sessionID: String, type: String, payload: JSONValue) throws {
    guard let type = PerSessionMessageType(rawValue: type) else {
      throw RemoteProtocolError.unknownPerSessionMessageType(type)
    }
    self = .session(.init(sessionID: sessionID, type: type, payload: payload))
  }

  func jsonString() throws -> String {
    let session = try sessionID.map(JSONValue.string)?.jsonString() ?? "null"
    let messageType = try JSONValue.string(type).jsonString()
    return "{\"sessionId\":\(session),\"type\":\(messageType),"
      + "\"payload\":\(try payload.jsonString())}"
  }
}

private func extractRawPayload(from json: String) throws -> String {
  var scanner = JSONTopLevelScanner(json)
  return try scanner.objectValue(forKey: "payload")
}

private struct JSONTopLevelScanner {
  private let json: String
  private var index: String.Index

  init(_ json: String) {
    self.json = json
    self.index = json.startIndex
  }

  mutating func objectValue(forKey targetKey: String) throws -> String {
    try skipWhitespace()
    try consume("{")
    while true {
      try skipWhitespace()
      if try consumeIfPresent("}") {
        break
      }
      let key = try parseString()
      try skipWhitespace()
      try consume(":")
      try skipWhitespace()
      let valueStart = index
      try skipValue()
      if key == targetKey {
        return String(json[valueStart..<index])
      }
      try skipWhitespace()
      if try consumeIfPresent(",") {
        continue
      }
      try consume("}")
      break
    }
    throw RemoteProtocolError.missingRawPayload
  }

  private mutating func parseString() throws -> String {
    try consume("\"")
    var value = ""
    while index < json.endIndex {
      let character = json[index]
      json.formIndex(after: &index)
      if character == "\"" {
        return value
      }
      if character == "\\" {
        guard index < json.endIndex else { throw RemoteProtocolError.missingRawPayload }
        value.append(json[index])
        json.formIndex(after: &index)
      } else {
        value.append(character)
      }
    }
    throw RemoteProtocolError.missingRawPayload
  }

  private mutating func skipValue() throws {
    guard index < json.endIndex else { throw RemoteProtocolError.missingRawPayload }
    switch json[index] {
    case "{":
      try skipComposite(open: "{", close: "}")
    case "[":
      try skipComposite(open: "[", close: "]")
    case "\"":
      _ = try parseString()
    default:
      while index < json.endIndex && !",}]".contains(json[index]) {
        json.formIndex(after: &index)
      }
    }
  }

  private mutating func skipComposite(open: Character, close: Character) throws {
    var depth = 0
    while index < json.endIndex {
      let character = json[index]
      if character == "\"" {
        _ = try parseString()
        continue
      }
      json.formIndex(after: &index)
      if character == open {
        depth += 1
      } else if character == close {
        depth -= 1
        if depth == 0 {
          return
        }
      }
    }
    throw RemoteProtocolError.missingRawPayload
  }

  private mutating func skipWhitespace() throws {
    while index < json.endIndex && json[index].isWhitespace {
      json.formIndex(after: &index)
    }
  }

  private mutating func consume(_ expected: Character) throws {
    guard index < json.endIndex && json[index] == expected else {
      throw RemoteProtocolError.missingRawPayload
    }
    json.formIndex(after: &index)
  }

  private mutating func consumeIfPresent(_ expected: Character) throws -> Bool {
    guard index < json.endIndex && json[index] == expected else {
      return false
    }
    json.formIndex(after: &index)
    return true
  }
}
