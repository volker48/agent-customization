import PiRemoteClient
import SwiftUI

struct ChatRow: View {
  let item: ChatItem

  var body: some View {
    switch item.kind {
    case .user:
      UserBubble(text: item.text)
    case .assistant:
      AssistantMessage(item: item)
    case .tool:
      ToolActivityRow(item: item)
    case .other:
      if !item.text.isEmpty {
        Text(item.text)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity)
          .multilineTextAlignment(.center)
      }
    }
  }
}

private struct UserBubble: View {
  let text: String

  var body: some View {
    HStack {
      Spacer(minLength: 48)
      Text(text)
        .foregroundStyle(.white)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.tint, in: .rect(cornerRadius: 20))
        .textSelection(.enabled)
        .contextMenu { CopyButton(text: text) }
    }
  }
}

private struct AssistantMessage: View {
  let item: ChatItem

  /// The host projection writes a `Tool call: <name>` line into the assistant text for
  /// each tool call; the tool rows already show those, so they are hidden here.
  private var displayText: String {
    item.text
      .split(separator: "\n", omittingEmptySubsequences: false)
      .filter { !$0.hasPrefix("Tool call: ") }
      .joined(separator: "\n")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  var body: some View {
    let text = displayText
    if !text.isEmpty || item.isStreaming {
      VStack(alignment: .leading, spacing: 6) {
        MarkdownView(markdown: text)
        if item.truncatedOutput {
          TruncationNote()
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .contextMenu { CopyButton(text: text) }
    }
  }
}

private struct ToolActivityRow: View {
  let item: ChatItem
  @State private var isExpanded = false

  private var hasOutput: Bool { !item.text.isEmpty }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(.snappy) { isExpanded.toggle() }
      } label: {
        header
      }
      .buttonStyle(.plain)
      .disabled(!hasOutput)

      if isExpanded && hasOutput {
        Divider()
        ScrollView([.horizontal, .vertical]) {
          Text(item.text)
            .font(.caption.monospaced())
            .textSelection(.enabled)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 320)
        .fixedSize(horizontal: false, vertical: true)
        if item.truncatedOutput {
          TruncationNote()
            .padding([.horizontal, .bottom], 12)
        }
      }
    }
    .background(.fill.quaternary, in: .rect(cornerRadius: 14))
    .overlay {
      RoundedRectangle(cornerRadius: 14)
        .strokeBorder(item.toolRunState == .failed ? .red.opacity(0.4) : .clear)
    }
    .contextMenu {
      if hasOutput { CopyButton(text: item.text) }
    }
  }

  private var header: some View {
    HStack(spacing: 10) {
      Image(systemName: toolSymbol(item.toolName))
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.secondary)
        .frame(width: 20)
      Text(item.toolName ?? "tool")
        .font(.subheadline.monospaced().weight(.medium))
      if !isExpanded, let preview = firstLine(item.text) {
        Text(preview)
          .font(.caption.monospaced())
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      Spacer(minLength: 4)
      statusIcon
      if hasOutput {
        Image(systemName: "chevron.right")
          .font(.caption2.weight(.bold))
          .foregroundStyle(.tertiary)
          .rotationEffect(.degrees(isExpanded ? 90 : 0))
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .contentShape(.rect)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(item.toolName ?? "tool"), \(accessibilityStatus)")
  }

  @ViewBuilder
  private var statusIcon: some View {
    switch item.toolRunState {
    case .running:
      ProgressView().controlSize(.small)
    case .succeeded:
      Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
    case .failed:
      Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
    }
  }

  private var accessibilityStatus: String {
    switch item.toolRunState {
    case .running: "running"
    case .succeeded: "completed"
    case .failed: "failed"
    }
  }
}

private func firstLine(_ text: String) -> String? {
  text.split(separator: "\n").first.map { $0.trimmingCharacters(in: .whitespaces) }
}

private func toolSymbol(_ name: String?) -> String {
  switch name?.lowercased() {
  case "bash", "shell", "exec":
    "terminal"
  case "read", "view", "cat":
    "doc.text"
  case "edit", "write", "patch", "multiedit":
    "pencil"
  case "grep", "find", "glob", "ls", "search":
    "magnifyingglass"
  case "webfetch", "web_search", "exa_search", "fetch":
    "globe"
  case "subagent", "task", "agent":
    "person.2"
  default:
    "wrench.and.screwdriver"
  }
}

private struct TruncationNote: View {
  var body: some View {
    Label("Output truncated by the laptop", systemImage: "scissors")
      .font(.caption2)
      .foregroundStyle(.secondary)
  }
}

private struct CopyButton: View {
  let text: String

  var body: some View {
    Button("Copy", systemImage: "doc.on.doc") {
      UIPasteboard.general.string = text
    }
  }
}

struct MarkdownView: View {
  let markdown: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(Array(parseMarkdownBlocks(markdown).enumerated()), id: \.offset) { _, block in
        switch block {
        case .paragraph(let text):
          Text(inlineMarkdown(text))
            .textSelection(.enabled)
        case .heading(let level, let text):
          Text(inlineMarkdown(text))
            .font(headingFont(level))
            .padding(.top, 4)
        case .code(let language, let code):
          CodeBlock(language: language, code: code)
        }
      }
    }
  }

  private func headingFont(_ level: Int) -> Font {
    switch level {
    case 1: .title2.bold()
    case 2: .title3.bold()
    default: .headline
    }
  }
}

/// Renders inline Markdown (emphasis, code spans, links) with line breaks intact.
/// Text that isn't valid Markdown falls back to plain text rather than disappearing.
private func inlineMarkdown(_ text: String) -> AttributedString {
  let options = AttributedString.MarkdownParsingOptions(
    interpretedSyntax: .inlineOnlyPreservingWhitespace,
    failurePolicy: .returnPartiallyParsedIfPossible
  )
  return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
}

private struct CodeBlock: View {
  let language: String?
  let code: String
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(language ?? "code")
          .font(.caption.weight(.medium))
          .foregroundStyle(.secondary)
        Spacer()
        Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") {
          UIPasteboard.general.string = code
          copied = true
        }
        .font(.caption)
        .labelStyle(.iconOnly)
        .foregroundStyle(.secondary)
        .sensoryFeedback(.success, trigger: copied)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      Divider()
      ScrollView(.horizontal) {
        Text(code)
          .font(.footnote.monospaced())
          .textSelection(.enabled)
          .padding(12)
      }
    }
    .background(.fill.quaternary, in: .rect(cornerRadius: 12))
    .task(id: copied) {
      guard copied else { return }
      try? await Task.sleep(for: .seconds(1.5))
      copied = false
    }
  }
}
