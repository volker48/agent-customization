import Darwin
import Foundation
import PiRemoteClient

do {
  try runProtocolTests()
  try runProjectionTests()
  print("PiRemoteClient tests passed")
} catch {
  writeStandardError("PiRemoteClient tests failed: \(error)\n")
  exit(1)
}

private func runProtocolTests() throws {
  try envelopeRoundTripsTSGeneratedFixturesByteForByte()
  try jsonlFramingSplitsOnLFOnly()
  try controlAndPerSessionEnvelopesAreDistinctTypes()
}

private func runProjectionTests() throws {
  try liveAssistantDeltasCoalesceIntoOneGrowingItem()
  try backfillCompletedEntriesAppendDirectly()
  try toolActivityAndTruncationFieldsRemainRenderable()
}

private func envelopeRoundTripsTSGeneratedFixturesByteForByte() throws {
  for fixture in try loadProtocolFixtures() {
    let envelope = try decodeFrame(fixture.frame)

    let actual = String(decoding: try encodeFrame(envelope), as: UTF8.self)
    if actual != fixture.frame {
      let expected = fixture.frame.debugDescription
      let actualDescription = actual.debugDescription
      throw TestFailure.message(
        "\(fixture.name) expected \(expected) actual \(actualDescription)"
      )
    }
    try expect(envelope.channelName == fixture.channel)
  }
}

private func jsonlFramingSplitsOnLFOnly() throws {
  let fixtures = try loadProtocolFixtures()
  let unicodeSeparatorFrame = try require(
    fixtures.first { $0.name == "session event with escaped lf and unicode separators" }
  )
  let combined = unicodeSeparatorFrame.frame + fixtures[0].frame

  let envelopes = try decodeFrames(combined)

  try expect(envelopes.count == 2)
  try expect(try encodeFrameString(envelopes[0]) == unicodeSeparatorFrame.frame)
  try expect(try encodeFrameString(envelopes[1]) == fixtures[0].frame)
}

private func controlAndPerSessionEnvelopesAreDistinctTypes() throws {
  let control = Envelope.control(.init(type: .list, payload: .object([])))
  let session = Envelope.session(
    .init(sessionID: "session-1", type: .prompt, payload: .object([.init("text", "hi")]))
  )

  try expect(control.sessionID == nil)
  try expect(control.type == "list")
  try expect(session.sessionID == "session-1")
  try expect(session.type == "prompt")
}

private func liveAssistantDeltasCoalesceIntoOneGrowingItem() throws {
  var projection = ConversationProjection()

  projection.applyLive(.assistant(text: "Hel", status: "started"))
  projection.applyLive(.assistant(text: "Hello", status: "streaming"))
  projection.applyLive(.assistant(text: "Hello there", status: "completed"))

  try expect(projection.items == [.assistant(text: "Hello there", status: "completed")])
}

private func backfillCompletedEntriesAppendDirectly() throws {
  var projection = ConversationProjection()
  let backfill: [TranscriptEntry] = [
    .init(role: "user", text: "Question", toolName: nil, status: "completed"),
    .assistant(text: "Answer", status: "completed"),
  ]

  projection.appendBackfill(backfill)

  try expect(projection.items == backfill.map(ChatItem.init))
}

private func toolActivityAndTruncationFieldsRemainRenderable() throws {
  let entry = TranscriptEntry(
    role: "toolResult",
    text: "partial output…",
    toolName: "bash",
    status: "running",
    truncatedOutput: true
  )

  try expect(ChatItem(entry).toolName == "bash")
  try expect(ChatItem(entry).status == "running")
  try expect(ChatItem(entry).truncatedOutput)
}

private struct ProtocolFixture: Decodable {
  let name: String
  let channel: String
  let frame: String
}

private func loadProtocolFixtures() throws -> [ProtocolFixture] {
  let url = try require(
    Bundle.module.url(forResource: "protocol-fixtures", withExtension: "json")
  )
  let data = try Data(contentsOf: url)
  return try JSONDecoder().decode([ProtocolFixture].self, from: data)
}

private func encodeFrameString(_ envelope: Envelope) throws -> String {
  String(decoding: try encodeFrame(envelope), as: UTF8.self)
}

private extension Envelope {
  var channelName: String {
    switch self {
    case .control:
      "control"
    case .session:
      "session"
    }
  }
}

private enum TestFailure: Error, CustomStringConvertible {
  case failed(String, UInt)
  case message(String)
  case missingRequiredValue(String, UInt)

  var description: String {
    switch self {
    case .failed(let file, let line):
      "Expectation failed at \(file):\(line)"
    case .message(let message):
      message
    case .missingRequiredValue(let file, let line):
      "Required value missing at \(file):\(line)"
    }
  }
}

private func expect(
  _ condition: @autoclosure () throws -> Bool,
  file: StaticString = #filePath,
  line: UInt = #line
) throws {
  if try !condition() {
    throw TestFailure.failed(String(describing: file), line)
  }
}

private func require<T>(
  _ value: T?,
  file: StaticString = #filePath,
  line: UInt = #line
) throws -> T {
  guard let value else {
    throw TestFailure.missingRequiredValue(String(describing: file), line)
  }
  return value
}

private func writeStandardError(_ message: String) {
  FileHandle.standardError.write(Data(message.utf8))
}
