import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
public final class SessionStore {
  public private(set) var sessions: [RemoteSession]
  public private(set) var transcripts: [String: ConversationProjection]
  public private(set) var attachedSessionID: String?
  public private(set) var feedErrorMessage: String?
  public private(set) var steeringErrorMessage: String?

  private let client: RemoteClient

  public init(client: RemoteClient, sessions: [RemoteSession] = []) {
    self.client = client
    self.sessions = sessions
    self.transcripts = [:]
    self.attachedSessionID = nil
    self.feedErrorMessage = nil
    self.steeringErrorMessage = nil
  }

  public func refresh() async {
    do {
      sessions = try await client.list()
      feedErrorMessage = nil
    } catch {
      feedErrorMessage = String(describing: error)
    }
  }

  public func attach(to session: RemoteSession) async {
    attachedSessionID = session.sessionID
    transcripts[session.sessionID] = ConversationProjection()

    do {
      let stream = try await client.attachStream(sessionID: session.sessionID)
      for try await envelope in stream {
        try Task.checkCancellation()
        if try apply(envelope, to: session.sessionID) == .closed {
          break
        }
      }
      closeFeed(session.sessionID)
      feedErrorMessage = nil
    } catch is CancellationError {
      closeFeed(session.sessionID)
    } catch {
      closeFeed(session.sessionID)
      feedErrorMessage = String(describing: error)
    }
  }

  public func transcript(for sessionID: String) -> [ChatItem] {
    transcripts[sessionID]?.items ?? []
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

@available(iOS 17.5, macOS 14.5, *)
public struct SessionListView: View {
  private let store: SessionStore

  public init(store: SessionStore) {
    self.store = store
  }

  public var body: some View {
    NavigationStack {
      List(store.sessions) { session in
        NavigationLink {
          ConversationView(store: store, session: session)
        } label: {
          SessionRow(session: session)
        }
      }
      .navigationTitle("Remote Sessions")
      .overlay {
        if store.sessions.isEmpty {
          ContentUnavailableView("No Remote Sessions", systemImage: "iphone.slash")
        }
      }
      .refreshable {
        await store.refresh()
      }
      .task {
        await store.refresh()
      }
    }
  }
}

@available(iOS 17.5, macOS 14.5, *)
public struct ConversationView: View {
  private let store: SessionStore
  private let session: RemoteSession
  @State private var draft = ""

  public init(store: SessionStore, session: RemoteSession) {
    self.store = store
    self.session = session
  }

  public var body: some View {
    VStack(spacing: 0) {
      transcriptView
      if store.attachedSessionID != session.sessionID {
        disconnectedBanner
      }
      Composer(
        text: $draft,
        canSend: store.attachedSessionID == session.sessionID,
        onSend: sendPrompt,
        onStop: stopTurn
      )
    }
    .navigationTitle(session.name)
    .task(id: session.sessionID) {
      await store.attach(to: session)
    }
  }

  private var transcriptView: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 10) {
        ForEach(Array(store.transcript(for: session.sessionID).enumerated()), id: \.offset) {
          _, item in
          ChatBubble(item: item)
        }
      }
      .padding()
    }
  }

  private var disconnectedBanner: some View {
    Text("Feed disconnected")
      .font(.caption)
      .foregroundStyle(.secondary)
      .padding(8)
      .background(.thinMaterial, in: Capsule())
      .padding(.vertical, 8)
  }

  private func sendPrompt(_ text: String) async -> Bool {
    await store.sendPrompt(text, to: session.sessionID)
  }

  private func stopTurn() async {
    _ = await store.abort(sessionID: session.sessionID)
  }
}

private enum FeedAction {
  case keepOpen
  case closed
}

private extension SessionStore {
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

  func closeFeed(_ sessionID: String) {
    if attachedSessionID == sessionID {
      attachedSessionID = nil
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

@available(iOS 17.5, macOS 14.5, *)
private struct SessionRow: View {
  let session: RemoteSession

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(session.name)
        .font(.headline)
      Text(session.cwd)
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
  }
}

@available(iOS 17.5, macOS 14.5, *)
private struct Composer: View {
  @Binding var text: String
  let canSend: Bool
  let onSend: (String) async -> Bool
  let onStop: () async -> Void
  @State private var isSending = false
  @State private var isStopping = false

  private var trimmedText: String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  var body: some View {
    HStack(spacing: 8) {
      TextField("Steer the agent", text: $text, axis: .vertical)
        .textFieldStyle(.roundedBorder)
        .lineLimit(1...4)
      Button("Send") {
        send()
      }
      .disabled(trimmedText.isEmpty || !canSend || isSending)
      Button("Stop", role: .destructive) {
        stop()
      }
      .disabled(isStopping)
    }
    .padding()
    .background(.regularMaterial)
  }

  private func send() {
    let message = trimmedText
    isSending = true
    Task {
      if await onSend(message) {
        text = ""
      }
      isSending = false
    }
  }

  private func stop() {
    isStopping = true
    Task {
      await onStop()
      isStopping = false
    }
  }
}

@available(iOS 17.5, macOS 14.5, *)
private struct ChatBubble: View {
  let item: ChatItem

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      if let toolName = item.toolName, let status = item.status {
        Text("\(toolName) · \(status)")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Text(item.text)
        .font(.body)
      if item.truncatedOutput {
        Text("output truncated")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
    }
    .padding(10)
    .background(bubbleColor, in: RoundedRectangle(cornerRadius: 12))
    .frame(maxWidth: .infinity, alignment: item.role == "user" ? .trailing : .leading)
  }

  private var bubbleColor: Color {
    switch item.role {
    case "user":
      .blue.opacity(0.18)
    case "assistant":
      .green.opacity(0.16)
    case "toolResult":
      .orange.opacity(0.14)
    default:
      .gray.opacity(0.14)
    }
  }
}
