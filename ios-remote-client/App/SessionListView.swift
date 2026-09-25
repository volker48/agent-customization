import PiRemoteClient
import SwiftUI

struct SessionListView: View {
  let model: AppModel
  let store: SessionStore
  let client: RemoteClient

  @Environment(\.scenePhase) private var scenePhase
  @State private var path: [RemoteSession] = []
  @State private var hasLoaded = false
  @State private var showingSettings = false

  var body: some View {
    NavigationStack(path: $path) {
      content
        .navigationTitle("Sessions")
        .navigationDestination(for: RemoteSession.self) { session in
          ConversationView(store: store, session: session)
        }
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button("Settings", systemImage: "gearshape") { showingSettings = true }
          }
        }
        .refreshable { await store.refresh() }
        .task(id: isPolling) {
          // `.task(id:)` restarts when polling toggles; the closure re-checks so a
          // navigation push that races the restart still stops the loop.
          guard isPolling else { return }
          if !hasLoaded {
            await store.refresh()
            hasLoaded = true
          }
          await store.refreshSessionListUntilCancelled { isPolling }
        }
    }
    .sheet(isPresented: $showingSettings) {
      SettingsView(model: model, client: client)
    }
  }

  private var isPolling: Bool {
    scenePhase == .active && path.isEmpty
  }

  @ViewBuilder
  private var content: some View {
    if !hasLoaded {
      ProgressView("Connecting to your laptop…")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else if store.sessions.isEmpty {
      emptyState
    } else {
      List(store.sessions) { session in
        NavigationLink(value: session) {
          SessionRow(session: session)
        }
      }
      .safeAreaInset(edge: .top) {
        if let message = store.feedErrorMessage {
          InlineErrorBanner(message: message)
            .padding(.horizontal)
        }
      }
    }
  }

  @ViewBuilder
  private var emptyState: some View {
    if let message = store.feedErrorMessage {
      ContentUnavailableView {
        Label("Can't Reach Your Laptop", systemImage: "wifi.exclamationmark")
      } description: {
        Text(message)
      } actions: {
        Button("Try Again") { Task { await store.refresh() } }
          .buttonStyle(.glassProminent)
      }
    } else {
      ContentUnavailableView {
        Label("No Sessions", systemImage: "terminal")
      } description: {
        Text("Run **/remote** inside a Pi session on your laptop and it will show up here.")
      } actions: {
        Button("Refresh") { Task { await store.refresh() } }
          .buttonStyle(.glass)
      }
    }
  }
}

private struct SessionRow: View {
  let session: RemoteSession

  var body: some View {
    HStack(spacing: 14) {
      Image(systemName: "terminal.fill")
        .font(.title3)
        .foregroundStyle(.white)
        .frame(width: 42, height: 42)
        .background(sessionColor(session.name).gradient, in: .rect(cornerRadius: 11))
      VStack(alignment: .leading, spacing: 3) {
        Text(session.name)
          .font(.headline)
          .lineLimit(1)
        Text(abbreviatedPath(session.cwd))
          .font(.footnote.monospaced())
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.head)
      }
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
  }
}

struct InlineErrorBanner: View {
  let message: String

  var body: some View {
    Label {
      Text(message).lineLimit(3)
    } icon: {
      Image(systemName: "exclamationmark.triangle.fill")
    }
    .font(.footnote)
    .foregroundStyle(.red)
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .glassEffect(.regular.tint(.red.opacity(0.15)), in: .rect(cornerRadius: 14))
  }
}

/// Shortens `/Users/<name>/…` to `~/…`; the laptop's home is unknown on the phone,
/// so this matches the macOS home layout only.
func abbreviatedPath(_ path: String) -> String {
  let components = path.split(separator: "/", omittingEmptySubsequences: false)
  guard components.count >= 3, components[0].isEmpty, components[1] == "Users" else {
    return path
  }
  return (["~"] + components.dropFirst(3)).joined(separator: "/")
}

/// Stable per-name color so a session keeps its icon color across launches.
private func sessionColor(_ name: String) -> Color {
  let palette: [Color] = [.indigo, .teal, .orange, .pink, .purple, .blue, .green, .mint]
  let hash = name.unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) &+ $1.value }
  return palette[Int(hash % UInt32(palette.count))]
}
