import Foundation

public struct TranscriptEntry: Codable, Equatable, Sendable {
  public let role: String
  public let text: String
  public let toolName: String?
  public let status: String?
  public let truncatedOutput: Bool
  /// Present on tool activity from current hosts; older hosts omit it.
  public let toolCallId: String?

  public init(
    role: String,
    text: String,
    toolName: String? = nil,
    status: String? = nil,
    truncatedOutput: Bool = false,
    toolCallId: String? = nil
  ) {
    self.role = role
    self.text = text
    self.toolName = toolName
    self.status = status
    self.truncatedOutput = truncatedOutput
    self.toolCallId = toolCallId
  }

  public static func assistant(text: String, status: String) -> TranscriptEntry {
    TranscriptEntry(role: "assistant", text: text, status: status)
  }
}

public enum ChatItemKind: Equatable, Sendable {
  case user
  case assistant
  case tool
  case other
}

public enum ToolRunState: Equatable, Sendable {
  case running
  case succeeded
  case failed
}

public struct ChatItem: Codable, Equatable, Identifiable, Sendable {
  public let id: String
  public let role: String
  public let text: String
  public let toolName: String?
  public let status: String?
  public let truncatedOutput: Bool
  public let toolCallId: String?

  public init(_ entry: TranscriptEntry, id: String = "") {
    self.id = id
    self.role = entry.role
    self.text = entry.text
    self.toolName = entry.toolName
    self.status = entry.status
    self.truncatedOutput = entry.truncatedOutput
    self.toolCallId = entry.toolCallId
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.id = ""
    self.role = try container.decode(String.self, forKey: .role)
    self.text = try container.decode(String.self, forKey: .text)
    self.toolName = try container.decodeIfPresent(String.self, forKey: .toolName)
    self.status = try container.decodeIfPresent(String.self, forKey: .status)
    self.truncatedOutput = try container.decode(Bool.self, forKey: .truncatedOutput)
    self.toolCallId = try container.decodeIfPresent(String.self, forKey: .toolCallId)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(role, forKey: .role)
    try container.encode(text, forKey: .text)
    try container.encodeIfPresent(toolName, forKey: .toolName)
    try container.encodeIfPresent(status, forKey: .status)
    try container.encode(truncatedOutput, forKey: .truncatedOutput)
    try container.encodeIfPresent(toolCallId, forKey: .toolCallId)
  }

  public static func == (lhs: ChatItem, rhs: ChatItem) -> Bool {
    lhs.role == rhs.role && lhs.text == rhs.text && lhs.toolName == rhs.toolName
      && lhs.status == rhs.status && lhs.truncatedOutput == rhs.truncatedOutput
      && lhs.toolCallId == rhs.toolCallId
  }

  public static func assistant(text: String, status: String) -> ChatItem {
    ChatItem(.assistant(text: text, status: status))
  }

  public var kind: ChatItemKind {
    switch role {
    case "user":
      .user
    case "assistant":
      .assistant
    case "toolResult":
      .tool
    default:
      .other
    }
  }

  /// Only meaningful for `.tool` items.
  public var toolRunState: ToolRunState {
    switch status {
    case "error":
      .failed
    case "completed":
      .succeeded
    default:
      .running
    }
  }

  /// True while an assistant message is still receiving deltas.
  public var isStreaming: Bool {
    ["started", "streaming"].contains(status)
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
    case toolCallId
  }
}

public struct ConversationProjection: Equatable, Sendable {
  public private(set) var items: [ChatItem]
  /// Derived from live lifecycle frames only; backfill carries no run state, so a
  /// freshly attached feed reads idle until the host emits its next live event.
  public private(set) var isAgentWorking: Bool
  private let projectionID: String
  private var nextItemIndex: Int
  private var streamingMessageIndex: Array<ChatItem>.Index?
  private var toolItemIndexByCallID: [String: Array<ChatItem>.Index]

  public init(items: [ChatItem] = []) {
    self.items = items
    self.isAgentWorking = false
    self.projectionID = UUID().uuidString
    self.nextItemIndex = items.count
    self.streamingMessageIndex = nil
    self.toolItemIndexByCallID = [:]
  }

  public static func == (lhs: ConversationProjection, rhs: ConversationProjection) -> Bool {
    lhs.items == rhs.items && lhs.streamingMessageIndex == rhs.streamingMessageIndex
      && lhs.isAgentWorking == rhs.isAgentWorking
  }

  public mutating func appendBackfill(_ entries: [TranscriptEntry]) {
    for entry in entries where entry.isRenderable {
      if let toolCallId = entry.toolCallId, entry.role == "toolResult" {
        upsertTool(entry, toolCallId: toolCallId)
      } else {
        items.append(makeItem(entry))
      }
    }
    streamingMessageIndex = nil
  }

  public mutating func applyLive(_ entry: TranscriptEntry) {
    updateActivity(entry)
    guard entry.isRenderable else {
      return
    }
    if let toolCallId = entry.toolCallId, entry.role == "toolResult" {
      upsertTool(entry, toolCallId: toolCallId)
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

  mutating func updateActivity(_ entry: TranscriptEntry) {
    switch (entry.role, entry.status) {
    case ("system", "turn_started"), ("toolResult", "running"):
      isAgentWorking = true
    case ("user", "started"), ("assistant", "started"), ("assistant", "streaming"):
      isAgentWorking = true
    case ("system", "agent_completed"):
      isAgentWorking = false
    default:
      break
    }
  }

  mutating func upsertStreamingMessage(_ entry: TranscriptEntry) {
    if let streamingMessageIndex {
      items[streamingMessageIndex] = ChatItem(entry, id: items[streamingMessageIndex].id)
      return
    }

    items.append(makeItem(entry))
    streamingMessageIndex = items.index(before: items.endIndex)
  }

  /// Folds execution start/update/end and the trailing toolResult message for one
  /// call into a single row. Later frames never erase output or regress a finished
  /// status, because the toolResult message repeats the output as `started`/`completed`
  /// without the execution's error flag.
  mutating func upsertTool(_ entry: TranscriptEntry, toolCallId: String) {
    guard let index = toolItemIndexByCallID[toolCallId] else {
      items.append(makeItem(entry))
      toolItemIndexByCallID[toolCallId] = items.index(before: items.endIndex)
      return
    }

    let existing = items[index]
    let keepsOutput = entry.text.isEmpty
    let merged = TranscriptEntry(
      role: existing.role,
      text: keepsOutput ? existing.text : entry.text,
      toolName: entry.toolName ?? existing.toolName,
      status: mergedToolStatus(existing: existing.status, incoming: entry.status),
      truncatedOutput: keepsOutput ? existing.truncatedOutput : entry.truncatedOutput,
      toolCallId: toolCallId
    )
    items[index] = ChatItem(merged, id: existing.id)
  }
}

private func mergedToolStatus(existing: String?, incoming: String?) -> String? {
  switch (existing, incoming) {
  case ("error", _):
    "error"
  case ("completed", "started"), ("completed", "streaming"), ("completed", "running"):
    "completed"
  default:
    incoming ?? existing
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
