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

public struct ChatItem: Codable, Equatable, Identifiable, Sendable {
  public let id: String
  public let role: String
  public let text: String
  public let toolName: String?
  public let status: String?
  public let truncatedOutput: Bool

  public init(_ entry: TranscriptEntry, id: String = "") {
    self.id = id
    self.role = entry.role
    self.text = entry.text
    self.toolName = entry.toolName
    self.status = entry.status
    self.truncatedOutput = entry.truncatedOutput
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.id = ""
    self.role = try container.decode(String.self, forKey: .role)
    self.text = try container.decode(String.self, forKey: .text)
    self.toolName = try container.decodeIfPresent(String.self, forKey: .toolName)
    self.status = try container.decodeIfPresent(String.self, forKey: .status)
    self.truncatedOutput = try container.decode(Bool.self, forKey: .truncatedOutput)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(role, forKey: .role)
    try container.encode(text, forKey: .text)
    try container.encodeIfPresent(toolName, forKey: .toolName)
    try container.encodeIfPresent(status, forKey: .status)
    try container.encode(truncatedOutput, forKey: .truncatedOutput)
  }

  public static func == (lhs: ChatItem, rhs: ChatItem) -> Bool {
    lhs.role == rhs.role && lhs.text == rhs.text && lhs.toolName == rhs.toolName
      && lhs.status == rhs.status && lhs.truncatedOutput == rhs.truncatedOutput
  }

  public static func assistant(text: String, status: String) -> ChatItem {
    ChatItem(.assistant(text: text, status: status))
  }

  public var isCollapsedByDefault: Bool {
    role == "toolResult"
  }

  public var collapsedTitle: String {
    let parts = [toolName, status].compactMap { $0 }.filter { !$0.isEmpty }
    return parts.isEmpty ? role : parts.joined(separator: " · ")
  }

  private enum CodingKeys: String, CodingKey {
    case role
    case text
    case toolName
    case status
    case truncatedOutput
  }
}

public struct ConversationProjection: Equatable, Sendable {
  public private(set) var items: [ChatItem]
  private let projectionID: String
  private var nextItemIndex: Int
  private var streamingMessageIndex: Array<ChatItem>.Index?

  public init(items: [ChatItem] = []) {
    self.items = items
    self.projectionID = UUID().uuidString
    self.nextItemIndex = items.count
    self.streamingMessageIndex = nil
  }

  public static func == (lhs: ConversationProjection, rhs: ConversationProjection) -> Bool {
    lhs.items == rhs.items && lhs.streamingMessageIndex == rhs.streamingMessageIndex
  }

  public mutating func appendBackfill(_ entries: [TranscriptEntry]) {
    items.append(contentsOf: entries.filter(\.isRenderable).map { makeItem($0) })
    streamingMessageIndex = nil
  }

  public mutating func applyLive(_ entry: TranscriptEntry) {
    guard entry.isRenderable else {
      return
    }
    guard entry.isMessageDelta else {
      items.append(makeItem(entry))
      return
    }

    upsertStreamingMessage(entry)
    if entry.status == "completed" {
      streamingMessageIndex = nil
    }
  }
}

private extension ConversationProjection {
  mutating func makeItem(_ entry: TranscriptEntry) -> ChatItem {
    defer { nextItemIndex += 1 }
    return ChatItem(entry, id: "\(projectionID):\(nextItemIndex)")
  }

  mutating func upsertStreamingMessage(_ entry: TranscriptEntry) {
    if let streamingMessageIndex {
      items[streamingMessageIndex] = ChatItem(entry, id: items[streamingMessageIndex].id)
      return
    }

    items.append(makeItem(entry))
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
