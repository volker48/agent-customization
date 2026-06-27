#if os(iOS) && canImport(VisionKit)
import SwiftUI
import VisionKit

@available(iOS 17.5, *)
public struct QRCodeScannerView: UIViewControllerRepresentable {
  private let onTicketScanned: (String) -> Void
  private let onError: (Error) -> Void

  public init(
    onTicketScanned: @escaping (String) -> Void,
    onError: @escaping (Error) -> Void
  ) {
    self.onTicketScanned = onTicketScanned
    self.onError = onError
  }

  public func makeUIViewController(context: Context) -> DataScannerViewController {
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
      onError(error)
    }
    return controller
  }

  public func updateUIViewController(
    _ uiViewController: DataScannerViewController,
    context: Context
  ) {}

  public func makeCoordinator() -> Coordinator {
    Coordinator(onTicketScanned: onTicketScanned)
  }

  public final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    private let onTicketScanned: (String) -> Void

    init(onTicketScanned: @escaping (String) -> Void) {
      self.onTicketScanned = onTicketScanned
    }

    public func dataScanner(
      _ dataScanner: DataScannerViewController,
      didTapOn item: RecognizedItem
    ) {
      guard case .barcode(let barcode) = item, let ticket = barcode.payloadStringValue else {
        return
      }
      onTicketScanned(ticket)
    }
  }
}
#endif
