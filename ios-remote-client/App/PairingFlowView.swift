import PiRemoteClient
import SwiftUI
import VisionKit

/// First-run flow: get the daemon ticket (QR or paste), then prove the pairing code.
struct PairingFlowView: View {
  let client: RemoteClient
  let onPaired: (String) -> Void

  @State private var ticket: String?
  @State private var isScanning = false
  @State private var pasteError: String?

  var body: some View {
    NavigationStack {
      Group {
        if let ticket {
          PairingCodeView(client: client, ticket: ticket, onPaired: onPaired) {
            self.ticket = nil
          }
          .transition(.move(edge: .trailing).combined(with: .opacity))
        } else {
          intro
            .transition(.move(edge: .leading).combined(with: .opacity))
        }
      }
      .animation(.snappy, value: ticket)
    }
    .fullScreenCover(isPresented: $isScanning) {
      QRScannerSheet { scanned in
        isScanning = false
        ticket = scanned
      }
    }
  }

  private var intro: some View {
    ScrollView {
      VStack(spacing: 28) {
        VStack(spacing: 12) {
          Image(systemName: "laptopcomputer.and.iphone")
            .font(.system(size: 64, weight: .light))
            .foregroundStyle(.tint)
            .symbolRenderingMode(.hierarchical)
            .padding(.top, 40)
          Text("Pi Remote")
            .font(.largeTitle.bold())
          Text("Watch and steer the Pi sessions running on your laptop.")
            .font(.title3)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
        }

        VStack(alignment: .leading, spacing: 18) {
          PairingStep(number: 1, text: "Run `/remote pair` in Pi on your laptop.")
          PairingStep(number: 2, text: "Scan the QR code it prints.")
          PairingStep(number: 3, text: "Enter the six-digit code shown under it.")
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.fill.quaternary, in: .rect(cornerRadius: 20))

        if let pasteError {
          Label(pasteError, systemImage: "exclamationmark.triangle.fill")
            .font(.footnote)
            .foregroundStyle(.red)
        }
      }
      .padding(.horizontal, 24)
    }
    .safeAreaInset(edge: .bottom) {
      VStack(spacing: 12) {
        if QRScannerSheet.isSupported {
          Button {
            isScanning = true
          } label: {
            Label("Scan QR Code", systemImage: "qrcode.viewfinder")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.glassProminent)
          .controlSize(.large)
        }
        HStack {
          Text("Or copy the Ticket line and")
            .font(.footnote)
            .foregroundStyle(.secondary)
          // PasteButton reads the clipboard without the system "Allow Paste" prompt.
          PasteButton(payloadType: String.self) { strings in
            useTicket(strings.first)
          }
          .buttonBorderShape(.capsule)
          .controlSize(.small)
        }
      }
      .padding(.horizontal, 24)
      .padding(.bottom, 12)
    }
  }

  private func useTicket(_ text: String?) {
    let pasted = text?.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let pasted, !pasted.isEmpty, !pasted.contains(where: \.isWhitespace) else {
      pasteError = "Copy the Ticket line printed by /remote pair, then try again."
      return
    }
    pasteError = nil
    ticket = pasted
  }
}

private struct PairingStep: View {
  let number: Int
  let text: LocalizedStringKey

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 14) {
      Text("\(number)")
        .font(.subheadline.bold().monospacedDigit())
        .foregroundStyle(.white)
        .frame(width: 26, height: 26)
        .background(.tint, in: .circle)
      Text(text)
        .font(.body)
    }
  }
}

private struct PairingCodeView: View {
  let client: RemoteClient
  let ticket: String
  let onPaired: (String) -> Void
  let onBack: () -> Void

  @State private var digits = ""
  @State private var isPairing = false
  @State private var errorMessage: String?
  @State private var failures = 0
  @FocusState private var isFocused: Bool

  var body: some View {
    VStack(spacing: 28) {
      VStack(spacing: 8) {
        Text("Enter Pairing Code")
          .font(.title.bold())
        Text("It's printed below the QR code and expires after five minutes.")
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
      }
      .padding(.top, 32)

      codeBoxes
        .phaseAnimator([0, 1, -1, 0], trigger: failures) { content, offset in
          content.offset(x: offset * 10)
        } animation: { _ in
          .spring(duration: 0.12)
        }

      if isPairing {
        ProgressView("Pairing…")
      } else if let errorMessage {
        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
          .font(.footnote)
          .foregroundStyle(.red)
          .multilineTextAlignment(.center)
      }

      Spacer()
    }
    .padding(.horizontal, 24)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Button("Back", systemImage: "chevron.backward", action: onBack)
      }
    }
    .onAppear { isFocused = true }
    .sensoryFeedback(.error, trigger: failures)
  }

  private var codeBoxes: some View {
    ZStack {
      TextField("", text: $digits)
        .keyboardType(.numberPad)
        .textContentType(.oneTimeCode)
        .focused($isFocused)
        .foregroundStyle(.clear)
        .tint(.clear)
        .onChange(of: digits) { _, newValue in
          let filtered = String(newValue.filter(\.isNumber).prefix(6))
          if filtered != newValue {
            digits = filtered
          } else if filtered.count == 6 {
            Task { await pair() }
          }
        }

      HStack(spacing: 8) {
        ForEach(0..<6, id: \.self) { index in
          if index == 3 {
            Text("–").font(.title2).foregroundStyle(.tertiary)
          }
          digitBox(at: index)
        }
      }
      .allowsHitTesting(false)
    }
    .contentShape(.rect)
    .onTapGesture { isFocused = true }
  }

  private func digitBox(at index: Int) -> some View {
    let characters = Array(digits)
    let isCurrent = isFocused && index == characters.count
    return Text(index < characters.count ? String(characters[index]) : "")
      .font(.system(.title, design: .rounded, weight: .semibold).monospacedDigit())
      .frame(width: 44, height: 56)
      .background(.fill.tertiary, in: .rect(cornerRadius: 12))
      .overlay {
        RoundedRectangle(cornerRadius: 12)
          .strokeBorder(isCurrent ? AnyShapeStyle(.tint) : AnyShapeStyle(.clear), lineWidth: 2)
      }
  }

  private func pair() async {
    guard !isPairing else { return }
    isPairing = true
    errorMessage = nil
    defer { isPairing = false }
    do {
      await client.updateTicket(ticket)
      try await client.pair(code: digits)
      onPaired(ticket)
    } catch {
      errorMessage = pairingErrorMessage(error)
      digits = ""
      failures += 1
    }
  }
}

private func pairingErrorMessage(_ error: Error) -> String {
  if case RemoteClientError.pairingRejected = error {
    return "That code didn't match. Run /remote pair again for a fresh code if it expired."
  }
  return "Couldn't reach your laptop: \(error)"
}

/// Full-screen camera that returns the first QR payload it recognizes, so the user
/// doesn't have to tap the highlighted code.
struct QRScannerSheet: View {
  static var isSupported: Bool { DataScannerViewController.isSupported }

  let onScan: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var scanError: String?

  var body: some View {
    ZStack(alignment: .top) {
      if let scanError {
        ContentUnavailableView(
          "Couldn't Start the Camera",
          systemImage: "camera.fill",
          description: Text(scanError)
        )
      } else if DataScannerViewController.isAvailable {
        QRScannerRepresentable(onScan: onScan) { error in
          scanError = error.localizedDescription
        }
        .ignoresSafeArea()
      } else {
        ContentUnavailableView(
          "Camera Unavailable",
          systemImage: "camera.fill",
          description: Text("Allow camera access in Settings, or paste the ticket instead.")
        )
      }

      HStack {
        Text("Point at the QR code from /remote pair")
          .font(.subheadline.weight(.medium))
          .padding(.horizontal, 14)
          .padding(.vertical, 10)
          .glassEffect()
        Spacer()
        Button("Close", systemImage: "xmark") { dismiss() }
          .labelStyle(.iconOnly)
          .buttonStyle(.glass)
          .buttonBorderShape(.circle)
          .controlSize(.large)
      }
      .padding()
    }
  }
}

private struct QRScannerRepresentable: UIViewControllerRepresentable {
  let onScan: (String) -> Void
  let onError: (Error) -> Void

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let controller = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])],
      qualityLevel: .balanced,
      recognizesMultipleItems: false,
      isHighFrameRateTrackingEnabled: false,
      isPinchToZoomEnabled: true,
      isGuidanceEnabled: true,
      isHighlightingEnabled: true
    )
    controller.delegate = context.coordinator
    do {
      try controller.startScanning()
    } catch {
      // Reported after this view update completes; SwiftUI state can't change mid-update.
      Task { @MainActor in onError(error) }
    }
    return controller
  }

  func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

  static func dismantleUIViewController(
    _ controller: DataScannerViewController,
    coordinator: Coordinator
  ) {
    controller.stopScanning()
  }

  func makeCoordinator() -> Coordinator {
    Coordinator(onScan: onScan)
  }

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    private let onScan: (String) -> Void
    private var didScan = false

    init(onScan: @escaping (String) -> Void) {
      self.onScan = onScan
    }

    func dataScanner(
      _ dataScanner: DataScannerViewController,
      didAdd addedItems: [RecognizedItem],
      allItems: [RecognizedItem]
    ) {
      for item in addedItems {
        guard !didScan, case .barcode(let barcode) = item,
          let payload = barcode.payloadStringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
          !payload.isEmpty
        else { continue }
        didScan = true
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onScan(payload)
      }
    }
  }
}
