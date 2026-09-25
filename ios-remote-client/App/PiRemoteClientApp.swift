import PiRemoteClient
import SwiftUI

@main
struct PiRemoteClientApp: App {
  @State private var model = AppModel()

  var body: some Scene {
    WindowGroup {
      RootView(model: model)
        .tint(.indigo)
    }
  }
}

/// Owns the device identity (via `RemoteClient`) and the saved daemon ticket.
/// The ticket is the only pairing state kept here; the laptop's allowlist is the
/// authority on whether this device is actually paired.
@MainActor
@Observable
final class AppModel {
  enum Phase {
    case starting
    case failed(String)
    case ready(RemoteClient)
  }

  private static let ticketKey = "remote.ticket"

  private(set) var phase: Phase = .starting
  private(set) var store: SessionStore?
  private(set) var ticket: String

  init() {
    ticket = UserDefaults.standard.string(forKey: Self.ticketKey) ?? ""
  }

  var isPaired: Bool { !ticket.isEmpty }

  func start() async {
    guard case .starting = phase else { return }
    do {
      let client = try await RemoteClient(ticket: isPaired ? ticket : nil)
      store = SessionStore(client: client)
      phase = .ready(client)
    } catch {
      phase = .failed(String(describing: error))
    }
  }

  func retry() {
    phase = .starting
  }

  /// Called after the daemon accepted the pairing code for `ticket`.
  func completePairing(ticket: String, client: RemoteClient) {
    self.ticket = ticket
    UserDefaults.standard.set(ticket, forKey: Self.ticketKey)
    store = SessionStore(client: client)
  }

  func forgetPairing() {
    ticket = ""
    UserDefaults.standard.removeObject(forKey: Self.ticketKey)
  }
}

private struct RootView: View {
  let model: AppModel

  var body: some View {
    Group {
      switch model.phase {
      case .starting:
        ProgressView("Starting Pi Remote…")
          .task { await model.start() }
      case .failed(let message):
        ContentUnavailableView {
          Label("Unable to Start", systemImage: "exclamationmark.triangle")
        } description: {
          Text(message)
        } actions: {
          Button("Try Again") { model.retry() }
            .buttonStyle(.glassProminent)
        }
      case .ready(let client):
        if model.isPaired, let store = model.store {
          SessionListView(model: model, store: store, client: client)
        } else {
          PairingFlowView(client: client) { ticket in
            model.completePairing(ticket: ticket, client: client)
          }
        }
      }
    }
    .animation(.default, value: model.isPaired)
  }
}
