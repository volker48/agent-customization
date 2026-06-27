import Foundation
import SwiftUI

@MainActor
public final class PairingViewModel: ObservableObject {
  @Published public var ticket: String
  @Published public var code: String
  @Published public private(set) var isPaired: Bool
  @Published public private(set) var errorMessage: String?

  private let client: RemoteClient

  public init(client: RemoteClient, ticket: String = "", code: String = "") {
    self.client = client
    self.ticket = ticket
    self.code = code
    self.isPaired = false
    self.errorMessage = nil
  }

  public func submitPairing() async {
    do {
      await client.updateTicket(ticket)
      isPaired = try await client.pair(code: code)
      errorMessage = nil
    } catch {
      isPaired = false
      errorMessage = String(describing: error)
    }
  }

  public func reportScannerError(_ error: Error) {
    errorMessage = "QR scanner failed: \(error)"
  }
}

@available(iOS 17.5, macOS 14.5, *)
public struct PairingView: View {
  @ObservedObject private var viewModel: PairingViewModel
  @State private var isScanning = false

  public init(viewModel: PairingViewModel) {
    self.viewModel = viewModel
  }

  public var body: some View {
    Form {
      Section("Ticket") {
        ticketTextField
        scanButton
      }

      Section("Pairing Code") {
        TextField("123-456", text: $viewModel.code)
#if os(iOS)
          .keyboardType(.numberPad)
#endif
        Button("Pair") {
          Task { await viewModel.submitPairing() }
        }
        .disabled(viewModel.ticket.isEmpty || viewModel.code.isEmpty)
      }

      if viewModel.isPaired {
        Label("Paired", systemImage: "checkmark.circle.fill")
          .foregroundStyle(.green)
      }

      if let errorMessage = viewModel.errorMessage {
        Text(errorMessage)
          .foregroundStyle(.red)
      }
    }
#if os(iOS) && canImport(VisionKit)
    .sheet(isPresented: $isScanning) {
      QRCodeScannerView(
        onTicketScanned: { ticket in
          viewModel.ticket = ticket
          isScanning = false
        },
        onError: { error in
          viewModel.reportScannerError(error)
          isScanning = false
        }
      )
    }
#endif
  }

  @ViewBuilder
  private var ticketTextField: some View {
#if os(iOS)
    TextField("iroh endpoint ticket", text: $viewModel.ticket, axis: .vertical)
      .textInputAutocapitalization(.never)
      .autocorrectionDisabled()
#else
    TextField("iroh endpoint ticket", text: $viewModel.ticket, axis: .vertical)
      .autocorrectionDisabled()
#endif
  }

  @ViewBuilder
  private var scanButton: some View {
#if os(iOS) && canImport(VisionKit)
    Button("Scan QR Ticket") {
      isScanning = true
    }
#else
    Text("Paste the QR ticket from /remote pair.")
      .foregroundStyle(.secondary)
#endif
  }
}
