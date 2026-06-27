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
  private var streamingAssistantIndex: Array<ChatItem>.Index?

  public init(items: [ChatItem] = []) {
    self.items = items
    self.streamingAssistantIndex = nil
  }

  public mutating func appendBackfill(_ entries: [TranscriptEntry]) {
    items.append(contentsOf: entries.map(ChatItem.init))
    streamingAssistantIndex = nil
  }

  public mutating func applyLive(_ entry: TranscriptEntry) {
    guard entry.isAssistantDelta else {
      items.append(ChatItem(entry))
      return
    }

    upsertStreamingAssistant(ChatItem(entry))
    if entry.status == "completed" {
      streamingAssistantIndex = nil
    }
  }
}

private extension ConversationProjection {
  mutating func upsertStreamingAssistant(_ item: ChatItem) {
    if let streamingAssistantIndex {
      items[streamingAssistantIndex] = item
      return
    }

    items.append(item)
    streamingAssistantIndex = items.index(before: items.endIndex)
  }
}

private extension TranscriptEntry {
  var isAssistantDelta: Bool {
    role == "assistant" && ["started", "streaming", "completed"].contains(status)
  }
}
