import Foundation
import SwiftUI

@MainActor
public final class SessionStore: ObservableObject {
  @Published public private(set) var sessions: [RemoteSession]
  @Published public private(set) var errorMessage: String?

  private let client: RemoteClient

  public init(client: RemoteClient, sessions: [RemoteSession] = []) {
    self.client = client
    self.sessions = sessions
    self.errorMessage = nil
  }

  public func refresh() async {
    do {
      sessions = try await client.list()
      errorMessage = nil
    } catch {
      errorMessage = String(describing: error)
    }
  }
}

@available(iOS 17.5, macOS 14.5, *)
public struct SessionListView: View {
  @ObservedObject private var store: SessionStore

  public init(store: SessionStore) {
    self.store = store
  }

  public var body: some View {
    List(store.sessions) { session in
      VStack(alignment: .leading, spacing: 4) {
        Text(session.name)
          .font(.headline)
        Text(session.cwd)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
    }
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
