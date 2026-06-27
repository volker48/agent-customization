import Foundation
import IrohLib

public struct RemoteSession: Codable, Equatable, Identifiable, Sendable {
  public let sessionID: String
  public let name: String
  public let cwd: String

  public var id: String { sessionID }

  public init(sessionID: String, name: String, cwd: String) {
    self.sessionID = sessionID
    self.name = name
    self.cwd = cwd
  }

  private enum CodingKeys: String, CodingKey {
    case sessionID = "sessionId"
    case name
    case cwd
  }
}

public enum RemoteClientError: Error, Equatable, CustomStringConvertible {
  case missingTicket
  case emptyResponse
  case unexpectedResponse(String)
  case pairingRejected
  case invalidPairingCode(String)
  case invalidPayload(String)

  public var description: String {
    switch self {
    case .missingTicket:
      "No daemon ticket is configured. Scan or paste the /remote pair ticket."
    case .emptyResponse:
      "The remote daemon closed the stream without a response."
    case .unexpectedResponse(let message):
      "Unexpected remote daemon response: \(message)"
    case .pairingRejected:
      "The remote daemon rejected the pairing code."
    case .invalidPairingCode(let code):
      "Pairing code must be six digits, optionally formatted as 123-456: \(code)"
    case .invalidPayload(let message):
      "Invalid remote daemon payload: \(message)"
    }
  }
}

public protocol SecretKeyStore: Sendable {
  func loadSecretKey() throws -> Data?
  func saveSecretKey(_ data: Data) throws
}

public protocol RemoteTransport: Sendable {
  var localNodeID: String { get }
  func request(ticket: String, envelopes: [Envelope]) async throws -> [Envelope]
}

public actor RemoteClient {
  private var ticket: String?
  private let transport: any RemoteTransport

  public var localNodeID: String { transport.localNodeID }

  public init(
    ticket: String? = nil,
    keyStore: any SecretKeyStore = KeychainSecretKeyStore()
  ) async throws {
    let secretKey = try loadOrCreateSecretKey(keyStore: keyStore)
    self.ticket = ticket
    self.transport = try await IrohRemoteTransport(secretKeyBytes: secretKey.toBytes())
  }

  public init(ticket: String? = nil, transport: any RemoteTransport) {
    self.ticket = ticket
    self.transport = transport
  }

  public func updateTicket(_ ticket: String) {
    self.ticket = ticket
  }

  @discardableResult
  public func pair(code: String) async throws -> Bool {
    let pairingCode = try PairingCode(code).value
    let responses = try await requestControl(.pair, payload: ["code": .string(pairingCode)])
    guard let responseEnvelope = responses.first else {
      throw RemoteClientError.pairingRejected
    }

    let payload = try requireControlPayload(responseEnvelope, type: .pair)
    let response = try decodePayload(PairResponse.self, from: payload)
    guard response.paired else {
      throw RemoteClientError.pairingRejected
    }
    return true
  }

  public func list() async throws -> [RemoteSession] {
    let responses = try await requestControl(.list, payload: .object([]))
    let payload = try requireControlPayload(responses.first, type: .list)
    return try decodePayload([RemoteSession].self, from: payload)
  }
}

public struct PairingCode: Equatable, Sendable {
  public let value: String

  public init(_ input: String) throws {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    let pattern = #"^\d{3}-?\d{3}$"#
    guard trimmed.range(of: pattern, options: .regularExpression) != nil else {
      throw RemoteClientError.invalidPairingCode(input)
    }

    let digits = trimmed.replacingOccurrences(of: "-", with: "")
    let split = digits.index(digits.startIndex, offsetBy: 3)
    self.value = "\(digits[..<split])-\(digits[split...])"
  }
}

public final class IrohRemoteTransport: RemoteTransport, @unchecked Sendable {
  public let localNodeID: String

  private let endpoint: Endpoint
  private let alpn: Data
  private let maxResponseBytes: UInt32

  public init(secretKeyBytes: Data, maxResponseBytes: UInt32 = 10 * 1024 * 1024) async throws {
    let secretKey = try SecretKey.fromBytes(bytes: secretKeyBytes)
    self.localNodeID = secretKey.public().description
    self.alpn = Data(remoteControlALPN.utf8)
    self.maxResponseBytes = maxResponseBytes
    self.endpoint = try await Endpoint.bind(
      options: EndpointOptions(
        preset: presetN0(),
        secretKey: secretKeyBytes,
        alpns: [alpn]
      )
    )
  }

  public func request(ticket: String, envelopes: [Envelope]) async throws -> [Envelope] {
    let daemonAddress = try EndpointTicket.fromString(str: ticket).endpointAddr()
    let connection = try await endpoint.connect(addr: daemonAddress, alpn: alpn)
    let stream = try await connection.openBi()

    let send = stream.send()
    for envelope in envelopes {
      try await send.writeAll(buf: encodeFrame(envelope))
    }
    try await send.finish()

    let response = try await stream.recv().readToEnd(sizeLimit: maxResponseBytes)
    return try decodeFrames(response)
  }
}

private struct PairResponse: Decodable {
  let paired: Bool
}

private extension RemoteClient {
  func requestControl(_ type: ControlMessageType, payload: JSONValue) async throws -> [Envelope] {
    guard let ticket else {
      throw RemoteClientError.missingTicket
    }

    let envelope = Envelope.control(.init(type: type, payload: payload))
    return try await transport.request(ticket: ticket, envelopes: [envelope])
  }
}

private func loadOrCreateSecretKey(keyStore: any SecretKeyStore) throws -> SecretKey {
  if let saved = try keyStore.loadSecretKey() {
    return try SecretKey.fromBytes(bytes: saved)
  }

  let secretKey = SecretKey.generate()
  try keyStore.saveSecretKey(secretKey.toBytes())
  return secretKey
}

private func requireControlPayload(
  _ envelope: Envelope?,
  type: ControlMessageType
) throws -> JSONValue {
  guard let envelope else {
    throw RemoteClientError.emptyResponse
  }

  guard case .control(let control) = envelope, control.type == type else {
    let message = "expected control \(type.rawValue), got \(envelope.type)"
    throw RemoteClientError.unexpectedResponse(message)
  }

  return control.payload
}

private func decodePayload<T: Decodable>(_ type: T.Type, from payload: JSONValue) throws -> T {
  do {
    return try JSONDecoder().decode(type, from: payload.jsonData())
  } catch {
    throw RemoteClientError.invalidPayload(String(describing: error))
  }
}
