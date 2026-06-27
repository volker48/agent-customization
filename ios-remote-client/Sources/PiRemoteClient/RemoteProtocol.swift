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
  var start = input.startIndex
  var index = input.startIndex

  while index < input.endIndex {
    if input[index] == 0x0A {
      if start < index {
        try frames.append(decodeFrame(input[start..<index]))
      }
      start = input.index(after: index)
    }
    index = input.index(after: index)
  }

  if start < input.endIndex {
    try frames.append(decodeFrame(input[start..<input.endIndex]))
  }

  return frames
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
    return "{\"sessionId\":\(session),\"type\":\(messageType)," +
      "\"payload\":\(try payload.jsonString())}"
  }
}

private func extractRawPayload(from json: String) throws -> String {
  guard let payloadRange = json.range(of: "\"payload\":") else {
    throw RemoteProtocolError.missingRawPayload
  }

  var payload = String(json[payloadRange.upperBound...])
  while payload.last?.isWhitespace == true {
    payload.removeLast()
  }
  guard payload.last == "}" else {
    throw RemoteProtocolError.missingRawPayload
  }
  payload.removeLast()
  return payload
}
