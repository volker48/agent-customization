import PiRemoteClient
import SwiftUI

struct ConversationView: View {
  let store: SessionStore
  let session: RemoteSession

  @Environment(\.scenePhase) private var scenePhase
  @State private var draft = ""
  @State private var attachAttempt = 0
  @State private var scrollPosition = ScrollPosition(edge: .bottom)
  @State private var isNearBottom = true
  @State private var sentCount = 0
  @State private var stopCount = 0
  @State private var capsule: CapsuleBrief?
  @State private var isLoadingCapsule = false
  @State private var showingCapsule = false

  private var items: [ChatItem] { store.transcript(for: session.sessionID) }
  private var isWorking: Bool { store.isAgentWorking(in: session.sessionID) }
  private var isConnected: Bool { store.isAttached(to: session.sessionID) }

  var body: some View {
    transcript
      .safeAreaInset(edge: .bottom, spacing: 0) {
        VStack(spacing: 8) {
          statusBanners
          Composer(
            text: $draft,
            isConnected: isConnected,
            isWorking: isWorking,
            onSend: send,
            onStop: stop
          )
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
      }
      .navigationTitle(session.name)
      .navigationSubtitle(subtitle)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { toolbarMenu }
      .task(id: "\(session.sessionID):\(attachAttempt)") {
        await store.attach(to: session)
      }
      .onChange(of: scenePhase) { _, phase in
        if phase == .active && store.attachedSessionID != session.sessionID {
          attachAttempt += 1
        }
      }
      .sensoryFeedback(.impact(weight: .light), trigger: sentCount)
      .sensoryFeedback(.impact(weight: .heavy), trigger: stopCount)
      .sheet(isPresented: $showingCapsule) {
        if let capsule {
          NavigationStack { CapsuleBriefView(capsule: capsule) }
            .presentationDetents([.medium, .large])
        }
      }
  }

  private var subtitle: String {
    switch store.connectionState {
    case .connected where store.attachedSessionID == session.sessionID:
      isWorking ? "Working…" : abbreviatedPath(session.cwd)
    case .disconnected:
      "Disconnected"
    default:
      "Connecting…"
    }
  }

  private var transcript: some View {
    ScrollView {
      // Not lazy: estimated heights for unrealized rows let the bottom anchor
      // overshoot into blank space as streamed rows resize. Transcripts are bounded
      // by the host's per-entry truncation, so eager layout stays cheap.
      VStack(alignment: .leading, spacing: 14) {
        ForEach(items) { item in
          ChatRow(item: item)
        }
        if isWorking && !(items.last.map(isVisiblyStreaming) ?? false) {
          WorkingIndicator()
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .scrollTargetLayout()
    }
    .scrollPosition($scrollPosition)
    // Bottom-anchored for every role: opens at the latest message and stays pinned
    // there as the keyboard resizes the viewport or streamed content grows it.
    .defaultScrollAnchor(.bottom)
    .scrollDismissesKeyboard(.interactively)
    .onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.visibleRect.maxY >= geometry.contentSize.height - 80
    } action: { _, nearBottom in
      isNearBottom = nearBottom
    }
    .overlay(alignment: .bottomTrailing) {
      if !isNearBottom {
        Button("Jump to Latest", systemImage: "arrow.down") {
          withAnimation { scrollPosition.scrollTo(edge: .bottom) }
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .padding(16)
        .transition(.scale.combined(with: .opacity))
      }
    }
    .overlay {
      if items.isEmpty {
        if isConnected {
          ContentUnavailableView(
            "No Messages Yet",
            systemImage: "bubble.left.and.text.bubble.right",
            description: Text("Send a message to start the agent.")
          )
        } else {
          ProgressView()
        }
      }
    }
    .animation(.snappy, value: isNearBottom)
  }

  @ViewBuilder
  private var statusBanners: some View {
    if let message = store.steeringErrorMessage {
      InlineErrorBanner(message: "Couldn't send: \(message)")
    }
    if store.attachedSessionID == session.sessionID, let message = store.feedErrorMessage {
      InlineErrorBanner(message: message)
    } else if store.connectionState == .disconnected
      || store.attachedSessionID != session.sessionID
    {
      disconnectedBanner
    }
  }

  private var disconnectedBanner: some View {
    HStack {
      Label(
        store.feedErrorMessage ?? "This session isn't connected.",
        systemImage: "bolt.horizontal.circle"
      )
      .font(.footnote)
      .lineLimit(3)
      Spacer()
      Button("Reconnect") { attachAttempt += 1 }
        .buttonStyle(.glass)
        .controlSize(.small)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    .glassEffect(in: .rect(cornerRadius: 14))
  }

  private var toolbarMenu: some ToolbarContent {
    ToolbarItem(placement: .topBarTrailing) {
      Menu("Actions", systemImage: "ellipsis") {
        Button("Stop Agent", systemImage: "stop.fill", role: .destructive) {
          stop()
        }
        .disabled(!isConnected)
        Button("Context Capsule", systemImage: "doc.text.magnifyingglass") {
          Task { await loadCapsule() }
        }
        .disabled(!isConnected || isLoadingCapsule)
        Button("Reconnect", systemImage: "arrow.clockwise") {
          attachAttempt += 1
        }
        if let error = store.capsuleErrorMessages[session.sessionID] {
          Section("Capsule") { Text(error) }
        }
      }
    }
  }

  private func send() {
    let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !message.isEmpty else { return }
    draft = ""
    sentCount += 1
    scrollPosition.scrollTo(edge: .bottom)
    Task {
      if !(await store.sendPrompt(message, to: session.sessionID)) && draft.isEmpty {
        draft = message
      }
    }
  }

  private func stop() {
    stopCount += 1
    Task { _ = await store.abort(sessionID: session.sessionID) }
  }

  private func loadCapsule() async {
    isLoadingCapsule = true
    defer { isLoadingCapsule = false }
    capsule = await store.fetchCapsule(for: session.sessionID)
    showingCapsule = capsule != nil
  }
}

private func isVisiblyStreaming(_ item: ChatItem) -> Bool {
  switch item.kind {
  case .assistant: item.isStreaming
  case .tool: item.toolRunState == .running
  default: false
  }
}

private struct Composer: View {
  @Binding var text: String
  let isConnected: Bool
  let isWorking: Bool
  let onSend: () -> Void
  let onStop: () -> Void

  @FocusState private var isFocused: Bool

  private var canSend: Bool {
    isConnected && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    GlassEffectContainer(spacing: 8) {
      HStack(alignment: .bottom, spacing: 8) {
        TextField(
          isConnected ? (isWorking ? "Steer the agent" : "Message Pi") : "Waiting for connection…",
          text: $text,
          axis: .vertical
        )
        .lineLimit(1...6)
        .focused($isFocused)
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22))
        .disabled(!isConnected)

        if isWorking && isConnected {
          Button(action: onStop) {
            Image(systemName: "stop.fill")
              .font(.body.weight(.semibold))
              .frame(width: 30, height: 30)
          }
          .accessibilityLabel("Stop")
          .buttonStyle(.glass)
          .buttonBorderShape(.circle)
          .tint(.red)
          .transition(.scale.combined(with: .opacity))
        }

        if canSend || !isWorking {
          Button(action: onSend) {
            Image(systemName: "arrow.up")
              .font(.body.weight(.bold))
              .frame(width: 30, height: 30)
          }
          .accessibilityLabel("Send")
          .buttonStyle(.glassProminent)
          .buttonBorderShape(.circle)
          .disabled(!canSend)
          .transition(.scale.combined(with: .opacity))
        }
      }
    }
    .animation(.snappy, value: isWorking)
    .animation(.snappy, value: canSend)
  }
}

private struct WorkingIndicator: View {
  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "ellipsis")
        .symbolEffect(.variableColor.iterative.dimInactiveLayers, options: .repeating)
      Text("Working")
    }
    .font(.subheadline.weight(.medium))
    .foregroundStyle(.secondary)
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    .background(.fill.tertiary, in: .capsule)
    .accessibilityLabel("Agent is working")
  }
}

struct CapsuleBriefView: View {
  let capsule: CapsuleBrief
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    List {
      Section("Objective") {
        Text(capsule.objective)
      }
      ForEach(capsule.compactSections, id: \.title) { section in
        Section(section.title) {
          ForEach(Array(section.items.enumerated()), id: \.offset) { _, item in
            Text(item)
          }
        }
      }
      Section {
        ForEach(capsule.redactions, id: \.category) { redaction in
          LabeledContent(redaction.category, value: "\(redaction.count) omitted")
        }
      } header: {
        Text("Host Safety Boundary")
      } footer: {
        Text(
          "Generated and redacted on the laptop, bounded to \(capsule.maxPayloadBytes) bytes."
            + (capsule.truncated ? " Some content was truncated to fit." : ""))
      }
    }
    .navigationTitle("Context Capsule")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .confirmationAction) {
        Button("Done", systemImage: "checkmark") { dismiss() }
      }
    }
  }
}
