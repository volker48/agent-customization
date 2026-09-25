import Foundation
import Observation

public enum ConnectionState: Equatable, Sendable {
  case connected
  case reconnecting
  case disconnected
}

@MainActor
@Observable
public final class SessionStore {
  public private(set) var sessions: [RemoteSession]
  public private(set) var transcripts: [String: ConversationProjection]
  public private(set) var attachedSessionID: String?
  public private(set) var connectionState: ConnectionState
  public private(set) var feedErrorMessage: String?
  public private(set) var steeringErrorMessage: String?
  public private(set) var capsuleErrorMessages: [String: String]
  public private(set) var capsules: [String: CapsuleBrief]

  /// Compatibility accessor for callers that display the currently attached session.
  public var capsuleErrorMessage: String? {
    guard let sessionID = attachedSessionID else { return nil }
    return capsuleErrorMessages[sessionID]
  }

  private let client: RemoteClient
  private let reconnectDelayNanoseconds: UInt64
  private let registryRefreshIntervalNanoseconds: UInt64
  /// Identifies the newest `attach` call. A superseded loop (another session, or a
  /// re-attach of the same one) must neither apply frames nor tear down its successor.
  private var attachGeneration = 0

  public init(
    client: RemoteClient,
    sessions: [RemoteSession] = [],
    reconnectDelayNanoseconds: UInt64 = 1_000_000_000,
    registryRefreshIntervalNanoseconds: UInt64 = 2_000_000_000
  ) {
    self.client = client
    self.sessions = sessions
    self.transcripts = [:]
    self.attachedSessionID = nil
    self.connectionState = .disconnected
    self.feedErrorMessage = nil
    self.steeringErrorMessage = nil
    self.capsuleErrorMessages = [:]
    self.capsules = [:]
    self.reconnectDelayNanoseconds = reconnectDelayNanoseconds
    self.registryRefreshIntervalNanoseconds = registryRefreshIntervalNanoseconds
  }

  public func refresh() async {
    do {
      sessions = try await client.list()
      feedErrorMessage = nil
    } catch {
      feedErrorMessage = String(describing: error)
    }
  }

  public func refreshSessionListUntilCancelled(
    when shouldRefresh: @MainActor () -> Bool = { true }
  ) async {
    while !Task.isCancelled {
      if shouldRefresh() {
        await refresh()
      }
      await sleepBeforeRegistryRefresh()
    }
  }

  public func attach(to session: RemoteSession) async {
    attachGeneration += 1
    let generation = attachGeneration
    attachedSessionID = session.sessionID
    connectionState = .reconnecting

    while attachGeneration == generation && !Task.isCancelled {
      do {
        let action = try await runAttachStream(for: session.sessionID, generation: generation)
        guard attachGeneration == generation else { return }
        if action == .closed {
          closeFeed(generation: generation)
          feedErrorMessage = nil
          return
        }
        feedErrorMessage = nil
        connectionState = .reconnecting
        await sleepBeforeReconnect()
      } catch is CancellationError {
        closeFeed(generation: generation)
        return
      } catch {
        guard attachGeneration == generation else { return }
        feedErrorMessage = String(describing: error)
        if error is RemoteClientError || error is RemoteProtocolError {
          closeFeed(generation: generation)
          return
        }
        connectionState = .reconnecting
        await sleepBeforeReconnect()
      }
    }
    closeFeed(generation: generation)
  }

  public func transcript(for sessionID: String) -> [ChatItem] {
    transcripts[sessionID]?.items ?? []
  }

  public func isAgentWorking(in sessionID: String) -> Bool {
    transcripts[sessionID]?.isAgentWorking ?? false
  }

  public func sessionState(for sessionID: String) -> SessionState? {
    transcripts[sessionID]?.sessionState
  }

  public func sendPrompt(_ text: String, to sessionID: String) async -> Bool {
    do {
      try await client.sendPrompt(sessionID: sessionID, text: text)
      steeringErrorMessage = nil
      return true
    } catch {
      steeringErrorMessage = String(describing: error)
      return false
    }
  }

  /// Asks the host to switch models. Success means the frame was sent; the session
  /// state follows the host's next push, so a rejected switch never shows as applied.
  public func selectModel(_ model: ModelChoice, in sessionID: String) async -> Bool {
    await sendPrompt("/model \(model.reference)", to: sessionID)
  }

  /// Asks the host to change the thinking level; see `selectModel(_:in:)`.
  public func selectThinkingLevel(_ level: String, in sessionID: String) async -> Bool {
    await sendPrompt("/thinking \(level)", to: sessionID)
  }

  public func fetchCapsule(for sessionID: String) async -> CapsuleBrief? {
    do {
      let capsule = try await client.fetchCapsule(sessionID: sessionID)
      try Task.checkCancellation()
      capsules[sessionID] = capsule
      capsuleErrorMessages[sessionID] = nil
      return capsule
    } catch is CancellationError {
      return nil
    } catch {
      guard !Task.isCancelled else { return nil }
      capsuleErrorMessages[sessionID] = String(describing: error)
      return nil
    }
  }

  public func isAttached(to sessionID: String) -> Bool {
    attachedSessionID == sessionID && connectionState == .connected
  }

  public func capsule(for sessionID: String) -> CapsuleBrief? {
    capsules[sessionID]
  }

  public func abort(sessionID: String) async -> Bool {
    do {
      try await client.abort(sessionID: sessionID)
      steeringErrorMessage = nil
      return true
    } catch {
      steeringErrorMessage = String(describing: error)
      return false
    }
  }
}

private enum FeedAction {
  case keepOpen
  case closed
}

private extension SessionStore {
  func runAttachStream(for sessionID: String, generation: Int) async throws -> FeedAction {
    let stream = try await client.attachStream(sessionID: sessionID)
    var receivedFrame = false

    for try await envelope in stream {
      try Task.checkCancellation()
      guard attachGeneration == generation else {
        return .keepOpen
      }
      if !receivedFrame {
        // Each attach resends a full backfill, so the prior transcript stays on
        // screen through a reconnect and is replaced only once fresh frames arrive.
        transcripts[sessionID] = ConversationProjection()
        connectionState = .connected
        receivedFrame = true
      }
      if try apply(envelope, to: sessionID) == .closed {
        return .closed
      }
    }
    return .keepOpen
  }

  func sleepBeforeReconnect() async {
    await sleep(ifNonzero: reconnectDelayNanoseconds)
  }

  func sleepBeforeRegistryRefresh() async {
    await sleep(ifNonzero: registryRefreshIntervalNanoseconds)
  }

  func sleep(ifNonzero nanoseconds: UInt64) async {
    guard nanoseconds > 0 else {
      return
    }
    try? await Task.sleep(nanoseconds: nanoseconds)
  }

  func apply(_ envelope: Envelope, to sessionID: String) throws -> FeedAction {
    switch envelope {
    case .control(let control):
      return try applyControl(control, sessionID: sessionID)
    case .session(let session) where session.sessionID == sessionID && session.type == .event:
      try appendEvent(session.payload, to: sessionID)
      return .keepOpen
    case .session:
      return .keepOpen
    }
  }

  func applyControl(_ control: ControlEnvelope, sessionID: String) throws -> FeedAction {
    if control.type == .sessionEnded {
      let ended = try decodeSessionEnded(control.payload)
      return ended == sessionID ? .closed : .keepOpen
    }
    return .keepOpen
  }

  func appendEvent(_ payload: JSONValue, to sessionID: String) throws {
    let entry = try decodeTranscriptEntry(payload)
    var projection = transcripts[sessionID] ?? ConversationProjection()
    projection.applyLive(entry)
    transcripts[sessionID] = projection
  }

  func closeFeed(generation: Int) {
    if attachGeneration == generation {
      attachedSessionID = nil
      connectionState = .disconnected
    }
  }
}

private func decodeTranscriptEntry(_ payload: JSONValue) throws -> TranscriptEntry {
  do {
    return try JSONDecoder().decode(TranscriptEntry.self, from: payload.jsonData())
  } catch {
    throw RemoteClientError.invalidPayload(String(describing: error))
  }
}

private func decodeSessionEnded(_ payload: JSONValue) throws -> String? {
  struct SessionEndedPayload: Decodable {
    let sessionId: String
  }

  do {
    return try JSONDecoder().decode(SessionEndedPayload.self, from: payload.jsonData()).sessionId
  } catch {
    throw RemoteClientError.invalidPayload(String(describing: error))
  }
}
