import Foundation
import Observation
import SwiftUI

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

  private let client: RemoteClient
  private let reconnectDelayNanoseconds: UInt64
  private let registryRefreshIntervalNanoseconds: UInt64

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
    attachedSessionID = session.sessionID
    connectionState = .reconnecting

    while attachedSessionID == session.sessionID && !Task.isCancelled {
      transcripts[session.sessionID] = ConversationProjection()

      do {
        let action = try await runAttachStream(for: session.sessionID)
        if action == .closed {
          closeFeed(session.sessionID)
          feedErrorMessage = nil
          return
        }
        feedErrorMessage = nil
        connectionState = .reconnecting
        await sleepBeforeReconnect()
      } catch is CancellationError {
        closeFeed(session.sessionID)
        return
      } catch {
        feedErrorMessage = String(describing: error)
        if error is RemoteClientError || error is RemoteProtocolError {
          closeFeed(session.sessionID)
          return
        }
        connectionState = .reconnecting
        await sleepBeforeReconnect()
      }
    }
    closeFeed(session.sessionID)
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
  @Environment(\.scenePhase) private var scenePhase
  @State private var navigationPath: [RemoteSession] = []

  public init(store: SessionStore) {
    self.store = store
  }

  public var body: some View {
    NavigationStack(path: $navigationPath) {
      List(store.sessions) { session in
        NavigationLink(value: session) {
          SessionRow(session: session)
        }
      }
      .navigationTitle("Remote Sessions")
      .navigationDestination(for: RemoteSession.self) { session in
        ConversationView(store: store, session: session)
      }
      .overlay {
        if store.sessions.isEmpty {
          ContentUnavailableView("No Remote Sessions", systemImage: "iphone.slash")
        }
      }
      .refreshable {
        await store.refresh()
      }
      .task(id: registryPollingIsActive) {
        // Check registryPollingIsActive at .task(id:) startup and again in the
        // refreshSessionListUntilCancelled closure to close the state-change /
        // cancellation race window; the inner check is intentional.
        guard registryPollingIsActive else {
          return
        }
        await store.refreshSessionListUntilCancelled {
          registryPollingIsActive
        }
      }
    }
  }

  private var registryPollingIsActive: Bool {
    scenePhase == .active && navigationPath.isEmpty
  }
}

@available(iOS 17.5, macOS 14.5, *)
public struct ConversationView: View {
  private let store: SessionStore
  private let session: RemoteSession
  @Environment(\.scenePhase) private var scenePhase
  @State private var draft = ""
  @State private var attachAttempt = 0
  private let latestMessageAnchorID = "latest-message-anchor"

  public init(store: SessionStore, session: RemoteSession) {
    self.store = store
    self.session = session
  }

  public var body: some View {
    VStack(spacing: 0) {
      transcriptView
      connectionStatusBanner
      Composer(
        text: $draft,
        canSend: canSendPrompt,
        onSend: sendPrompt,
        onStop: stopTurn
      )
    }
    .navigationTitle(session.name)
    .task(id: attachTaskID) {
      await store.attach(to: session)
    }
    .onChange(of: scenePhase) { _, phase in
      guard phase == .active && store.attachedSessionID != session.sessionID else {
        return
      }
      attachAttempt += 1
    }
  }

  private var attachTaskID: String {
    "\(session.sessionID):\(attachAttempt)"
  }

  private var transcriptView: some View {
    ScrollViewReader { proxy in
      ZStack(alignment: .bottomTrailing) {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 10) {
            ForEach(store.transcript(for: session.sessionID)) { item in
              ChatBubble(item: item)
            }
            Color.clear
              .frame(height: 1)
              .id(latestMessageAnchorID)
          }
          .padding()
        }
        latestButton(proxy)
      }
    }
  }

  private var canSendPrompt: Bool {
    store.attachedSessionID == session.sessionID && store.connectionState == .connected
  }

  private var connectionStatusBanner: some View {
    ConnectionStatusBanner(state: store.connectionState)
      .padding(.vertical, 8)
  }

  private func sendPrompt(_ text: String) async -> Bool {
    await store.sendPrompt(text, to: session.sessionID)
  }

  private func stopTurn() async {
    _ = await store.abort(sessionID: session.sessionID)
  }

  private func latestButton(_ proxy: ScrollViewProxy) -> some View {
    Button {
      scrollToLatest(proxy)
    } label: {
      Label("Latest", systemImage: "arrow.down.to.line")
    }
    .font(.caption.weight(.semibold))
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(.regularMaterial, in: Capsule())
    .padding()
    .accessibilityLabel("Jump to latest message")
  }

  private func scrollToLatest(_ proxy: ScrollViewProxy) {
    withAnimation {
      proxy.scrollTo(latestMessageAnchorID, anchor: .bottom)
    }
  }
}

private enum FeedAction {
  case keepOpen
  case closed
}

private extension SessionStore {
  func runAttachStream(for sessionID: String) async throws -> FeedAction {
    let stream = try await client.attachStream(sessionID: sessionID)
    var receivedFrame = false

    for try await envelope in stream {
      try Task.checkCancellation()
      guard attachedSessionID == sessionID else {
        return .keepOpen
      }
      if !receivedFrame {
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

  func closeFeed(_ sessionID: String) {
    if attachedSessionID == sessionID {
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
private struct ConnectionStatusBanner: View {
  let state: ConnectionState

  var body: some View {
    Label(title, systemImage: systemImage)
      .font(.caption)
      .foregroundStyle(foregroundStyle)
      .padding(8)
      .background(.thinMaterial, in: Capsule())
  }

  private var title: String {
    switch state {
    case .connected:
      "Connected"
    case .reconnecting:
      "Reconnecting…"
    case .disconnected:
      "Disconnected"
    }
  }

  private var systemImage: String {
    switch state {
    case .connected:
      "checkmark.circle.fill"
    case .reconnecting:
      "arrow.triangle.2.circlepath"
    case .disconnected:
      "wifi.slash"
    }
  }

  private var foregroundStyle: Color {
    switch state {
    case .connected:
      .green
    case .reconnecting:
      .secondary
    case .disconnected:
      .red
    }
  }
}

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
  @State private var isExpanded: Bool

  init(item: ChatItem) {
    self.item = item
    self._isExpanded = State(initialValue: !item.isCollapsedByDefault)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if item.isCollapsedByDefault {
        collapsedHeader
      }
      if isExpanded {
        expandedContent
      }
    }
    .padding(10)
    .background(bubbleColor, in: RoundedRectangle(cornerRadius: 12))
    .frame(maxWidth: .infinity, alignment: item.role == "user" ? .trailing : .leading)
    .onTapGesture {
      toggleIfExpandable()
    }
    .accessibilityElement(children: .combine)
  }

  private var collapsedHeader: some View {
    HStack(spacing: 6) {
      if hasExpandableContent {
        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
          .font(.caption2.weight(.bold))
      }
      Text(item.collapsedTitle)
        .font(.caption)
        .foregroundStyle(.secondary)
      if hasExpandableContent && !isExpanded {
        Text("Tap to expand")
          .font(.caption2)
          .foregroundStyle(.tertiary)
      }
    }
  }

  @ViewBuilder
  private var expandedContent: some View {
    if !item.isCollapsedByDefault && (item.toolName != nil || item.status != nil) {
      Text(item.collapsedTitle)
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    if !item.text.isEmpty {
      Text(item.text)
        .font(.body)
    }
    if item.truncatedOutput {
      Text("output truncated")
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
  }

  private var hasExpandableContent: Bool {
    !item.text.isEmpty || item.truncatedOutput
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

  private func toggleIfExpandable() {
    guard item.isCollapsedByDefault && hasExpandableContent else {
      return
    }
    withAnimation {
      isExpanded.toggle()
    }
  }
}
