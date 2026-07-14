import PiRemoteClient
import SwiftUI

@main
struct PiRemoteClientApp: App {
  var body: some Scene {
    WindowGroup {
      RootView()
    }
  }
}

@MainActor
private struct RootView: View {
  @AppStorage("remote.ticket") private var savedTicket = ""
  @State private var client: RemoteClient?
  @State private var startupError: String?

  var body: some View {
    Group {
      if let startupError {
        ContentUnavailableView(
          "Unable to Start",
          systemImage: "exclamationmark.triangle",
          description: Text(startupError)
        )
      } else if let client {
        ClientView(client: client, savedTicket: savedTicket)
          .id(savedTicket)
      } else {
        ProgressView("Starting Pi Remote…")
      }
    }
    .task {
      await startClient()
    }
  }

  private func startClient() async {
    guard client == nil, startupError == nil else {
      return
    }

    do {
      client = try await RemoteClient(ticket: savedTicket.isEmpty ? nil : savedTicket)
    } catch {
      startupError = String(describing: error)
    }
  }
}

@MainActor
private struct ClientView: View {
  @AppStorage("remote.ticket") private var savedTicket = ""
  @StateObject private var pairingViewModel: PairingViewModel
  @State private var sessionStore: SessionStore?
  private let client: RemoteClient

  init(client: RemoteClient, savedTicket: String) {
    self.client = client
    _pairingViewModel = StateObject(
      wrappedValue: PairingViewModel(client: client, ticket: savedTicket)
    )
  }

  var body: some View {
    Group {
      if !savedTicket.isEmpty, let sessionStore {
        SessionListView(store: sessionStore)
          .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
              Button("Re-pair") {
                savedTicket = ""
              }
            }
          }
      } else {
        PairingView(viewModel: pairingViewModel)
          .onChange(of: pairingViewModel.isPaired) { _, isPaired in
            if isPaired {
              savedTicket = pairingViewModel.ticket
            }
          }
      }
    }
    .task {
      if sessionStore == nil {
        sessionStore = SessionStore(client: client)
      }
    }
  }
}
