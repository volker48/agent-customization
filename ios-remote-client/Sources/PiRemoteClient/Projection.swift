import Foundation

public struct TranscriptEntry: Codable, Equatable, Sendable {
  public let role: String
  public let text: String
  public let toolName: String?
  public let status: String?
  public let truncatedOutput: Bool

  public init(
    role: String,
    text: String,
    toolName: String? = nil,
    status: String? = nil,
    truncatedOutput: Bool = false
  ) {
    self.role = role
    self.text = text
    self.toolName = toolName
    self.status = status
    self.truncatedOutput = truncatedOutput
  }

  public static func assistant(text: String, status: String) -> TranscriptEntry {
    TranscriptEntry(role: "assistant", text: text, status: status)
  }
}

public struct ChatItem: Codable, Equatable, Sendable {
  public let role: String
  public let text: String
  public let toolName: String?
  public let status: String?
  public let truncatedOutput: Bool

  public init(_ entry: TranscriptEntry) {
    self.role = entry.role
    self.text = entry.text
    self.toolName = entry.toolName
    self.status = entry.status
    self.truncatedOutput = entry.truncatedOutput
  }

  public static func assistant(text: String, status: String) -> ChatItem {
    ChatItem(.assistant(text: text, status: status))
  }
}

public struct ConversationProjection: Equatable, Sendable {
  public private(set) var items: [ChatItem]
  private var streamingMessageIndex: Array<ChatItem>.Index?

  public init(items: [ChatItem] = []) {
    self.items = items
    self.streamingMessageIndex = nil
  }

  public mutating func appendBackfill(_ entries: [TranscriptEntry]) {
    items.append(contentsOf: entries.filter(\.isRenderable).map(ChatItem.init))
    streamingMessageIndex = nil
  }

  public mutating func applyLive(_ entry: TranscriptEntry) {
    guard entry.isRenderable else {
      return
    }
    guard entry.isMessageDelta else {
      items.append(ChatItem(entry))
      return
    }

    upsertStreamingMessage(ChatItem(entry))
    if entry.status == "completed" {
      streamingMessageIndex = nil
    }
  }
}

private extension ConversationProjection {
  mutating func upsertStreamingMessage(_ item: ChatItem) {
    if let streamingMessageIndex {
      items[streamingMessageIndex] = item
      return
    }

    items.append(item)
    streamingMessageIndex = items.index(before: items.endIndex)
  }
}

private extension TranscriptEntry {
  var isRenderable: Bool {
    !text.isEmpty || toolName != nil || truncatedOutput
  }

  var isMessageDelta: Bool {
    ["user", "assistant"].contains(role) && ["started", "streaming", "completed"].contains(status)
  }
}
