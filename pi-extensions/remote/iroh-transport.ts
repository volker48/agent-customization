import {
  Endpoint,
  RelayMode,
  type BiStream,
  type Connection,
  type EndpointAddr,
} from "@number0/iroh/index.js";

import { REMOTE_CONTROL_ALPN, decodeFrames, encodeFrame, type Envelope } from "./protocol.js";

const DEFAULT_READ_LIMIT_BYTES = 1024 * 1024;
const ALPN_BYTES = Array.from(Buffer.from(REMOTE_CONTROL_ALPN, "utf8"));

export type RemoteEndpoint = Endpoint;
export type RemoteConnection = Connection;
export type RemoteBiStream = BiStream;
export type RemoteEndpointAddr = EndpointAddr;

export async function bindEndpoint(): Promise<RemoteEndpoint> {
  const builder = Endpoint.builder();
  builder.applyN0();
  builder.alpns([ALPN_BYTES]);
  builder.relayMode(RelayMode.defaultMode());
  const endpoint = await builder.bind();
  await endpoint.online();
  return endpoint;
}

export async function connectEndpoint(
  endpoint: RemoteEndpoint,
  addr: RemoteEndpointAddr,
): Promise<RemoteConnection> {
  return endpoint.connect(addr, ALPN_BYTES);
}

export async function acceptConnection(endpoint: RemoteEndpoint): Promise<RemoteConnection> {
  const incoming = await endpoint.acceptNext();
  if (incoming === null) {
    throw new Error("iroh transport failed to accept connection: endpoint closed");
  }

  const accepting = await incoming.accept();
  const alpn = await accepting.alpn();
  if (!bytesEqual(alpn, ALPN_BYTES)) {
    throw new Error(`iroh transport rejected ALPN: ${Buffer.from(alpn).toString("utf8")}`);
  }

  return accepting.connect();
}

export async function openStream(connection: RemoteConnection): Promise<RemoteBiStream> {
  return connection.openBi();
}

export async function acceptStream(connection: RemoteConnection): Promise<RemoteBiStream> {
  return connection.acceptBi();
}

export async function sendEnvelope(stream: RemoteBiStream, envelope: Envelope): Promise<void> {
  await stream.send.writeAll(Array.from(Buffer.from(encodeFrame(envelope), "utf8")));
}

export async function finishSending(stream: RemoteBiStream): Promise<void> {
  await stream.send.finish();
}

export async function receiveEnvelopes(
  stream: RemoteBiStream,
  sizeLimit = DEFAULT_READ_LIMIT_BYTES,
): Promise<Envelope[]> {
  const bytes = await stream.recv.readToEnd(sizeLimit);
  return decodeFrames(Buffer.from(bytes).toString("utf8"));
}

export async function closeEndpoint(endpoint: RemoteEndpoint): Promise<void> {
  if (!endpoint.isClosed()) {
    await endpoint.close();
  }
}

function bytesEqual(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
