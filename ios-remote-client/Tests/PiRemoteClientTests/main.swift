import Darwin
import Foundation
import PiRemoteClient

do {
  try runProtocolTests()
  try runProjectionTests()
  try await runRemoteClientTests()
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
  try liveUserDeltasCoalesceIntoOneItem()
  try emptyLifecycleEntriesAreNotRendered()
  try backfillCompletedEntriesAppendDirectly()
  try toolActivityAndTruncationFieldsRemainRenderable()
}

private func runRemoteClientTests() async throws {
  try await pairAndListSendControlFrames()
  try await wrongPairResponseIsRejected()
  try await listSendsNoPairingCodeForAlreadyPairedIdentity()
  try await attachStreamSendsStreamingAttachAndSurfacesFrames()
  try await promptSendsPerSessionRequest()
  try await abortSendsPerSessionRequest()
  try await sendingPromptDoesNotDisturbLiveAttachFeed()
  try await sessionStoreReportsPromptFailureAsSteeringError()
  try await successfulPromptDoesNotClearFeedError()
  try await sessionStoreAbortSendsPerSessionRequest()
  try await sessionStoreAttachesAndRendersBackfillThenLiveDeltas()
  try await sessionStoreStopsFeedOnSessionEndedControlFrame()
  try await sessionStoreReconnectsAndReattachesAfterFeedError()
  try await sessionStoreReconnectsWhenFeedEndsCleanly()
  try await sessionStoreRefreshLoopTracksSessionRegistry()
  try await sessionStoreIgnoresSupersededSessionFeed()
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

private func liveUserDeltasCoalesceIntoOneItem() throws {
  var projection = ConversationProjection()

  projection.applyLive(.init(role: "user", text: "Woot", status: "started"))
  projection.applyLive(.init(role: "user", text: "Woot", status: "completed"))

  try expect(projection.items == [.init(.init(role: "user", text: "Woot", status: "completed"))])
}

private func emptyLifecycleEntriesAreNotRendered() throws {
  var projection = ConversationProjection()

  projection.applyLive(.init(role: "system", text: "", status: "turn_started"))
  projection.applyLive(.init(role: "toolResult", text: "", toolName: "bash", status: "running"))
  projection.appendBackfill([
    .init(role: "system", text: "", status: "turn_completed"),
  ])

  try expect(projection.items == [
    .init(.init(role: "toolResult", text: "", toolName: "bash", status: "running")),
  ])
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

private func pairAndListSendControlFrames() async throws {
  let transport = RecordingTransport(responses: [
    [.control(.init(type: .pair, payload: ["paired": true]))],
    [
      .control(
        .init(
          type: .list,
          payload: [
            ["sessionId": "session-1", "name": "Work session", "cwd": "/repo"],
          ]
        )
      ),
    ],
  ])
  let client = RemoteClient(ticket: "ticket", transport: transport)

  let paired = try await client.pair(code: "123456")
  try expect(paired)
  let sessions = try await client.list()

  try expect(sessions == [.init(sessionID: "session-1", name: "Work session", cwd: "/repo")])
  let requests = await transport.recordedRequests()
  try expect(requests.map(\.ticket) == ["ticket", "ticket"])
  try expect(try encodeFrameString(requests[0].envelopes[0]) == pairFrame(code: "123-456"))
  try expect(try encodeFrameString(requests[1].envelopes[0]) == listFrame())
}

private func wrongPairResponseIsRejected() async throws {
  let transport = RecordingTransport(responses: [[]])
  let client = RemoteClient(ticket: "ticket", transport: transport)

  try await expectThrows(RemoteClientError.pairingRejected) {
    try await client.pair(code: "123-456")
  }
}

private func listSendsNoPairingCodeForAlreadyPairedIdentity() async throws {
  let transport = RecordingTransport(responses: [
    [.control(.init(type: .list, payload: []))],
  ])
  let client = RemoteClient(ticket: "ticket", transport: transport)

  let sessions = try await client.list()
  try expect(sessions.isEmpty)

  let requests = await transport.recordedRequests()
  try expect(requests.count == 1)
  try expect(try encodeFrameString(requests[0].envelopes[0]) == listFrame())
}

private func attachStreamSendsStreamingAttachAndSurfacesFrames() async throws {
  let expectedFrames: [Envelope] = [
    .control(.init(type: .attach, payload: ["attached": true, "sessionId": "session-1"])),
    .session(.init(sessionID: "session-1", type: .event, payload: eventPayload(text: "hello"))),
  ]
  let transport = RecordingTransport(responses: [], streams: [expectedFrames])
  let client = RemoteClient(ticket: "ticket", transport: transport)

  var received: [Envelope] = []
  for try await envelope in try await client.attachStream(sessionID: "session-1") {
    received.append(envelope)
  }

  try expect(received == expectedFrames)
  let streams = await transport.recordedStreams()
  try expect(streams.map(\.ticket) == ["ticket"])
  try expect(try encodeFrameString(streams[0].envelopes[0]) == streamingAttachFrame())
}

private func promptSendsPerSessionRequest() async throws {
  let transport = RecordingTransport(responses: [[]])
  let client = RemoteClient(ticket: "ticket", transport: transport)

  try await client.sendPrompt(sessionID: "session-1", text: "Continue please")

  let requests = await transport.recordedRequests()
  try expect(requests.map(\.ticket) == ["ticket"])
  try expect(try encodeFrameString(requests[0].envelopes[0]) == promptFrame())
}

private func abortSendsPerSessionRequest() async throws {
  let transport = RecordingTransport(responses: [[]])
  let client = RemoteClient(ticket: "ticket", transport: transport)

  try await client.abort(sessionID: "session-1")

  let requests = await transport.recordedRequests()
  try expect(requests.map(\.ticket) == ["ticket"])
  try expect(try encodeFrameString(requests[0].envelopes[0]) == abortFrame())
}

private func sendingPromptDoesNotDisturbLiveAttachFeed() async throws {
  let transport = LiveAttachTransport()
  let client = RemoteClient(ticket: "ticket", transport: transport)
  let session = RemoteSession(sessionID: "session-1", name: "Work", cwd: "/repo")
  let store = await SessionStore(client: client)

  let attachTask = Task { await store.attach(to: session) }
  try await waitUntil {
    await store.transcript(for: "session-1").map(\.text) == ["before"]
  }

  let stateWhileAttached = await store.connectionState
  let sent = await store.sendPrompt("continue", to: "session-1")
  await attachTask.value

  let texts = await store.transcript(for: "session-1").map(\.text)
  let stateAfterFeedClosed = await store.connectionState
  let streamCount = await transport.recordedStreams().count
  let requestCount = await transport.recordedRequests().count

  try expect(stateWhileAttached == .connected)
  try expect(sent)
  try expect(texts == ["before", "after"])
  try expect(stateAfterFeedClosed == .disconnected)
  try expect(streamCount == 1)
  try expect(requestCount == 1)
}

private func sessionStoreReportsPromptFailureAsSteeringError() async throws {
  let transport = FailingRequestTransport(error: RemoteClientError.unexpectedResponse("boom"))
  let client = RemoteClient(ticket: "ticket", transport: transport)
  let store = await SessionStore(client: client)

  let sent = await store.sendPrompt("continue", to: "session-1")
  let steeringErrorMessage = await store.steeringErrorMessage
  let feedErrorMessage = await store.feedErrorMessage

  try expect(!sent)
  try expect(steeringErrorMessage != nil)
  try expect(feedErrorMessage == nil)
}

private func successfulPromptDoesNotClearFeedError() async throws {
  let badFeedFrames: [Envelope] = [
    .session(.init(sessionID: "session-1", type: .event, payload: ["role": "assistant"])),
  ]
  let transport = RecordingTransport(responses: [[]], streams: [badFeedFrames])
  let client = RemoteClient(ticket: "ticket", transport: transport)
  let store = await SessionStore(client: client)

  await store.attach(to: .init(sessionID: "session-1", name: "Work", cwd: "/repo"))
  let feedError = await store.feedErrorMessage
  let sent = await store.sendPrompt("continue", to: "session-1")
  let feedErrorAfterPrompt = await store.feedErrorMessage
  let steeringErrorAfterPrompt = await store.steeringErrorMessage

  try expect(feedError != nil)
  try expect(sent)
  try expect(feedErrorAfterPrompt == feedError)
  try expect(steeringErrorAfterPrompt == nil)
}

private func sessionStoreAbortSendsPerSessionRequest() async throws {
  let transport = RecordingTransport(responses: [[]])
  let client = RemoteClient(ticket: "ticket", transport: transport)
  let store = await SessionStore(client: client)

  let aborted = await store.abort(sessionID: "session-1")

  let requests = await transport.recordedRequests()
  try expect(aborted)
  try expect(requests.count == 1)
  try expect(try encodeFrameString(requests[0].envelopes[0]) == abortFrame())
}

private func sessionStoreAttachesAndRendersBackfillThenLiveDeltas() async throws {
  let frames: [Envelope] = [
    .control(.init(type: .attach, payload: ["attached": true, "sessionId": "session-1"])),
    .session(
      .init(
        sessionID: "session-1",
        type: .event,
        payload: eventPayload(role: "user", text: "Question")
      )
    ),
    .session(.init(sessionID: "session-1", type: .event, payload: eventPayload(text: "Answer"))),
    .session(
      .init(
        sessionID: "session-1",
        type: .event,
        payload: eventPayload(text: "Li", status: "started")
      )
    ),
    .session(
      .init(
        sessionID: "session-1",
        type: .event,
        payload: eventPayload(text: "Live", status: "streaming")
      )
    ),
    .session(
      .init(sessionID: "session-1", type: .event, payload: eventPayload(text: "Live answer"))
    ),
    .control(.init(type: .sessionEnded, payload: ["sessionId": "session-1"])),
  ]
  let store = await storeAttachedWith(frames)

  let texts = await store.transcript(for: "session-1").map(\.text)
  let attachedSessionID = await store.attachedSessionID
  let feedErrorMessage = await store.feedErrorMessage

  try expect(texts == ["Question", "Answer", "Live answer"])
  try expect(attachedSessionID == nil)
  try expect(feedErrorMessage == nil)
}

private func sessionStoreStopsFeedOnSessionEndedControlFrame() async throws {
  let frames: [Envelope] = [
    .control(.init(type: .attach, payload: ["attached": true, "sessionId": "session-1"])),
    .session(.init(sessionID: "session-1", type: .event, payload: eventPayload(text: "before"))),
    .control(.init(type: .sessionEnded, payload: ["sessionId": "session-1"])),
    .session(.init(sessionID: "session-1", type: .event, payload: eventPayload(text: "after"))),
  ]
  let store = await storeAttachedWith(frames)

  let texts = await store.transcript(for: "session-1").map(\.text)
  let attachedSessionID = await store.attachedSessionID

  try expect(texts == ["before"])
  try expect(attachedSessionID == nil)
}

private func sessionStoreIgnoresSupersededSessionFeed() async throws {
  let transport = SwitchingAttachTransport()
  let client = RemoteClient(ticket: "ticket", transport: transport)
  let store = await SessionStore(client: client, reconnectDelayNanoseconds: 0)
  let first = RemoteSession(sessionID: "session-1", name: "First", cwd: "/one")
  let second = RemoteSession(sessionID: "session-2", name: "Second", cwd: "/two")

  let firstTask = Task { await store.attach(to: first) }
  try await waitUntil {
    await store.transcript(for: "session-1").map(\.text) == ["first initial"]
  }
  let secondTask = Task { await store.attach(to: second) }
  await secondTask.value
  await firstTask.value

  let firstTexts = await store.transcript(for: "session-1").map(\.text)
  let secondTexts = await store.transcript(for: "session-2").map(\.text)
  let streamSessionIDs = await transport.streamSessionIDs()

  try expect(firstTexts == ["first initial"])
  try expect(secondTexts == ["second"])
  try expect(streamSessionIDs == ["session-1", "session-2"])
}

private func sessionStoreRefreshLoopTracksSessionRegistry() async throws {
  let secondList: [Envelope] = [.control(.init(type: .list, payload: [
    ["sessionId": "session-2", "name": "Second", "cwd": "/two"],
  ]))]
  let firstList: [Envelope] = [.control(.init(type: .list, payload: [
    ["sessionId": "session-1", "name": "First", "cwd": "/one"],
  ]))]
  let transport = RecordingTransport(
    responses: [firstList] + Array(repeating: secondList, count: 100)
  )
  let client = RemoteClient(ticket: "ticket", transport: transport)
  let store = await SessionStore(
    client: client,
    reconnectDelayNanoseconds: 0,
    registryRefreshIntervalNanoseconds: 1_000_000
  )

  let refreshTask = Task { await store.refreshSessionListUntilCancelled() }
  try await waitUntil {
    await store.sessions.map(\.sessionID) == ["session-2"]
  }
  refreshTask.cancel()

  let sessions = await store.sessions
  try expect(sessions == [.init(sessionID: "session-2", name: "Second", cwd: "/two")])
}

private func sessionStoreReconnectsWhenFeedEndsCleanly() async throws {
  let transport = ReconnectingAttachTransport(streams: [
    .success([liveEvent(text: "stale")]),
    .success([
      liveEvent(text: "fresh backfill"),
      .control(.init(type: .sessionEnded, payload: ["sessionId": "session-1"])),
    ]),
  ])
  let client = RemoteClient(ticket: "ticket", transport: transport)
  let store = await SessionStore(client: client, reconnectDelayNanoseconds: 0)

  await store.attach(to: .init(sessionID: "session-1", name: "Work", cwd: "/repo"))

  let texts = await store.transcript(for: "session-1").map(\.text)
  let streamCount = await transport.recordedStreams().count

  try expect(texts == ["fresh backfill"])
  try expect(streamCount == 2)
}

private func sessionStoreReconnectsAndReattachesAfterFeedError() async throws {
  let transport = ReconnectingAttachTransport(streams: [
    .failure([liveEvent(text: "stale")], TestFailure.message("wifi dropped")),
    .success([
      liveEvent(text: "fresh backfill"),
      .control(.init(type: .sessionEnded, payload: ["sessionId": "session-1"])),
    ]),
  ])
  let client = RemoteClient(ticket: "ticket", transport: transport)
  let store = await SessionStore(client: client, reconnectDelayNanoseconds: 0)

  await store.attach(to: .init(sessionID: "session-1", name: "Work", cwd: "/repo"))

  let texts = await store.transcript(for: "session-1").map(\.text)
  let attachedSessionID = await store.attachedSessionID
  let connectionState = await store.connectionState
  let streamCount = await transport.recordedStreams().count

  try expect(texts == ["fresh backfill"])
  try expect(attachedSessionID == nil)
  try expect(connectionState == .disconnected)
  try expect(streamCount == 2)
}

private func storeAttachedWith(_ frames: [Envelope]) async -> SessionStore {
  let transport = RecordingTransport(responses: [], streams: [frames])
  let client = RemoteClient(ticket: "ticket", transport: transport)
  let store = await SessionStore(client: client)
  await store.attach(to: .init(sessionID: "session-1", name: "Work", cwd: "/repo"))
  return store
}

private struct RecordedRequest: Sendable {
  let ticket: String
  let envelopes: [Envelope]
}

private enum StreamScript: Sendable {
  case success([Envelope])
  case failure([Envelope], Error)
}

private actor SwitchingAttachTransport: RemoteTransport {
  nonisolated let localNodeID = "node-a"

  private var sessions: [String] = []
  private var secondStreamStarted: CheckedContinuation<Void, Never>?

  func request(ticket: String, envelopes: [Envelope]) async throws -> [Envelope] {
    []
  }

  nonisolated func stream(
    ticket: String,
    envelopes: [Envelope]
  ) -> AsyncThrowingStream<Envelope, Error> {
    AsyncThrowingStream { continuation in
      Task {
        let sessionID = await recordStream(envelopes: envelopes)
        if sessionID == "session-1" {
          continuation.yield(liveEvent(text: "first initial"))
          await waitForSecondStream()
          continuation.yield(liveEvent(text: "first after switch"))
          continuation.finish()
          return
        }
        continuation.yield(
          .session(.init(sessionID: sessionID, type: .event, payload: eventPayload(text: "second")))
        )
        continuation.yield(
          .control(.init(type: .sessionEnded, payload: ["sessionId": .string(sessionID)]))
        )
        continuation.finish()
      }
    }
  }

  func streamSessionIDs() -> [String] {
    sessions
  }

  private func recordStream(envelopes: [Envelope]) -> String {
    guard case .control(let envelope) = envelopes[0],
      case .object(let payload) = envelope.payload,
      case .string(let sessionID) = payload.first(where: { $0.key == "sessionId" })?.value
    else {
      return ""
    }

    sessions.append(sessionID)
    if sessions.count == 2 {
      secondStreamStarted?.resume()
      secondStreamStarted = nil
    }
    return sessionID
  }

  private func waitForSecondStream() async {
    if sessions.count >= 2 {
      return
    }
    await withCheckedContinuation { continuation in
      secondStreamStarted = continuation
    }
  }
}

private actor ReconnectingAttachTransport: RemoteTransport {
  nonisolated let localNodeID = "node-a"

  private var streams: [StreamScript]
  private var streamRequests: [RecordedRequest] = []

  init(streams: [StreamScript]) {
    self.streams = streams
  }

  func request(ticket: String, envelopes: [Envelope]) async throws -> [Envelope] {
    []
  }

  nonisolated func stream(
    ticket: String,
    envelopes: [Envelope]
  ) -> AsyncThrowingStream<Envelope, Error> {
    AsyncThrowingStream { continuation in
      Task {
        let script = await recordStream(ticket: ticket, envelopes: envelopes)
        switch script {
        case .success(let frames):
          for frame in frames {
            continuation.yield(frame)
          }
          continuation.finish()
        case .failure(let frames, let error):
          for frame in frames {
            continuation.yield(frame)
          }
          continuation.finish(throwing: error)
        }
      }
    }
  }

  func recordedStreams() -> [RecordedRequest] {
    streamRequests
  }

  private func recordStream(ticket: String, envelopes: [Envelope]) -> StreamScript {
    streamRequests.append(.init(ticket: ticket, envelopes: envelopes))
    return streams.removeFirst()
  }
}

private actor LiveAttachTransport: RemoteTransport {
  nonisolated let localNodeID = "node-a"

  private var requests: [RecordedRequest] = []
  private var streamRequests: [RecordedRequest] = []
  private var promptContinuation: CheckedContinuation<Void, Never>?

  func request(ticket: String, envelopes: [Envelope]) async throws -> [Envelope] {
    requests.append(.init(ticket: ticket, envelopes: envelopes))
    if envelopes.contains(where: { $0.type == "prompt" }) {
      promptContinuation?.resume()
      promptContinuation = nil
    }
    return []
  }

  nonisolated func stream(
    ticket: String,
    envelopes: [Envelope]
  ) -> AsyncThrowingStream<Envelope, Error> {
    AsyncThrowingStream { continuation in
      Task {
        await recordStream(ticket: ticket, envelopes: envelopes)
        continuation.yield(liveEvent(text: "before"))
        await waitForPrompt()
        continuation.yield(liveEvent(text: "after"))
        continuation.yield(
          .control(.init(type: .sessionEnded, payload: ["sessionId": "session-1"]))
        )
        continuation.finish()
      }
    }
  }

  func recordedRequests() -> [RecordedRequest] {
    requests
  }

  func recordedStreams() -> [RecordedRequest] {
    streamRequests
  }

  private func recordStream(ticket: String, envelopes: [Envelope]) {
    streamRequests.append(.init(ticket: ticket, envelopes: envelopes))
  }

  private func waitForPrompt() async {
    if requests.contains(where: { $0.envelopes.contains(where: { $0.type == "prompt" }) }) {
      return
    }
    await withCheckedContinuation { continuation in
      promptContinuation = continuation
    }
  }
}

private actor FailingRequestTransport: RemoteTransport {
  nonisolated let localNodeID = "node-a"

  private let error: Error

  init(error: Error) {
    self.error = error
  }

  func request(ticket: String, envelopes: [Envelope]) async throws -> [Envelope] {
    throw error
  }

  nonisolated func stream(
    ticket: String,
    envelopes: [Envelope]
  ) -> AsyncThrowingStream<Envelope, Error> {
    AsyncThrowingStream { continuation in continuation.finish() }
  }
}

private actor RecordingTransport: RemoteTransport {
  nonisolated let localNodeID = "node-a"

  private var responses: [[Envelope]]
  private var streams: [[Envelope]]
  private var requests: [RecordedRequest]
  private var streamRequests: [RecordedRequest]

  init(responses: [[Envelope]], streams: [[Envelope]] = []) {
    self.responses = responses
    self.streams = streams
    self.requests = []
    self.streamRequests = []
  }

  func request(ticket: String, envelopes: [Envelope]) async throws -> [Envelope] {
    requests.append(.init(ticket: ticket, envelopes: envelopes))
    return responses.removeFirst()
  }

  nonisolated func stream(
    ticket: String,
    envelopes: [Envelope]
  ) -> AsyncThrowingStream<Envelope, Error> {
    AsyncThrowingStream { continuation in
      Task {
        let frames = await recordStream(ticket: ticket, envelopes: envelopes)
        for frame in frames {
          continuation.yield(frame)
        }
        continuation.finish()
      }
    }
  }

  func recordedRequests() -> [RecordedRequest] {
    requests
  }

  func recordedStreams() -> [RecordedRequest] {
    streamRequests
  }

  private func recordStream(ticket: String, envelopes: [Envelope]) -> [Envelope] {
    streamRequests.append(.init(ticket: ticket, envelopes: envelopes))
    return streams.removeFirst()
  }
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

private func pairFrame(code: String) -> String {
  "{\"sessionId\":null,\"type\":\"pair\",\"payload\":{\"code\":\"\(code)\"}}\n"
}

private func listFrame() -> String {
  "{\"sessionId\":null,\"type\":\"list\",\"payload\":{}}\n"
}

private func streamingAttachFrame() -> String {
  "{\"sessionId\":null,\"type\":\"attach\",\"payload\":{\"sessionId\":\"session-1\"," +
    "\"stream\":true}}\n"
}

private func promptFrame() -> String {
  "{\"sessionId\":\"session-1\",\"type\":\"prompt\",\"payload\":{\"text\":\"Continue please\"}}\n"
}

private func abortFrame() -> String {
  "{\"sessionId\":\"session-1\",\"type\":\"abort\",\"payload\":{}}\n"
}

private func liveEvent(text: String) -> Envelope {
  .session(.init(sessionID: "session-1", type: .event, payload: eventPayload(text: text)))
}

private func eventPayload(
  role: String = "assistant",
  text: String,
  status: String = "completed",
  toolName: JSONValue = .null,
  truncatedOutput: Bool = false
) -> JSONValue {
  [
    "role": .string(role),
    "text": .string(text),
    "toolName": toolName,
    "status": .string(status),
    "truncatedOutput": .bool(truncatedOutput),
  ]
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

private func waitUntil(
  timeoutNanoseconds: UInt64 = 2_000_000_000,
  condition: () async -> Bool
) async throws {
  let deadline = DispatchTime.now().uptimeNanoseconds + timeoutNanoseconds
  while DispatchTime.now().uptimeNanoseconds < deadline {
    if await condition() {
      return
    }
    try await Task.sleep(nanoseconds: 10_000_000)
  }
  throw TestFailure.message("Timed out waiting for async condition")
}

private func expectThrows<T: Error & Equatable>(
  _ expected: T,
  operation: () async throws -> Void,
  file: StaticString = #filePath,
  line: UInt = #line
) async throws {
  do {
    try await operation()
  } catch let error as T where error == expected {
    return
  } catch {
    throw TestFailure.message("Expected \(expected), got \(error)")
  }
  throw TestFailure.failed(String(describing: file), line)
}

private func writeStandardError(_ message: String) {
  FileHandle.standardError.write(Data(message.utf8))
}
