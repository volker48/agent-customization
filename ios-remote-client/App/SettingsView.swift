import PiRemoteClient
import SwiftUI

struct SettingsView: View {
  let model: AppModel
  let client: RemoteClient

  @Environment(\.dismiss) private var dismiss
  @State private var nodeID = ""
  @State private var confirmingRepair = false

  var body: some View {
    NavigationStack {
      Form {
        Section {
          LabeledContent("Device ID") {
            Text(nodeID)
              .font(.footnote.monospaced())
              .lineLimit(1)
              .truncationMode(.middle)
              .textSelection(.enabled)
          }
          Button("Copy Device ID", systemImage: "doc.on.doc") {
            UIPasteboard.general.string = nodeID
          }
        } header: {
          Text("This iPhone")
        } footer: {
          Text(
            "Your laptop authorizes this ID in ~/.pi/agent/remote/allowed-node-ids.json. "
              + "The key behind it never leaves this iPhone's Keychain.")
        }

        Section {
          Button("Pair Again", systemImage: "qrcode", role: .destructive) {
            confirmingRepair = true
          }
        } header: {
          Text("Laptop")
        } footer: {
          Text(
            "Use this if the laptop's daemon identity changed or you want to pair a different laptop."
          )
        }

        Section("About") {
          LabeledContent("Version", value: appVersion)
          LabeledContent("Protocol", value: remoteControlALPN)
        }
      }
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done", systemImage: "checkmark") { dismiss() }
        }
      }
      .confirmationDialog("Pair again?", isPresented: $confirmingRepair) {
        Button("Forget Laptop and Pair Again", role: .destructive) {
          dismiss()
          model.forgetPairing()
        }
      } message: {
        Text("You'll need to run /remote pair on the laptop and scan its QR code.")
      }
      .task { nodeID = await client.localNodeID }
    }
  }

  private var appVersion: String {
    let info = Bundle.main.infoDictionary
    let version = info?["CFBundleShortVersionString"] as? String ?? "?"
    let build = info?["CFBundleVersion"] as? String ?? "?"
    return "\(version) (\(build))"
  }
}
