import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startPrivateJsonLineServer } from "../src/companionServer.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

async function fixture(maxRequestBytes = 128) {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-json-lines-"));
  const socketPath = path.join(root, "control.sock");
  const dispatch = vi.fn(async (line: string) => ({ value: JSON.parse(line) }));
  const tooLarge = vi.fn(() => ({ error: "too large" }));
  const invalid = vi.fn(() => ({ error: "invalid" }));
  const server = await startPrivateJsonLineServer({
    socketPath, maxRequestBytes, maxResponseBytes: 128,
    dispatch, requestTooLarge: tooLarge, internalError: invalid
  });
  const socket = createConnection(socketPath);
  cleanups.push(async () => {
    socket.destroy();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve); socket.once("error", reject);
  });
  return { socket, dispatch, tooLarge, invalid };
}

function closed(socket: Socket): Promise<void> {
  return new Promise(resolve => socket.once("close", () => resolve()));
}

it("preserves split UTF-8 and frame order across fragmented and pipelined writes", async () => {
  const f = await fixture();
  f.socket.resume();
  const unicode = Buffer.from('"가🙂"\n');
  f.socket.write(unicode.subarray(0, 2));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.dispatch).not.toHaveBeenCalled();
  f.socket.write(Buffer.concat([unicode.subarray(2), Buffer.from('\n"second"\n"thi')]));
  await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(2));
  f.socket.write('rd"\n');
  await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledTimes(3));
  expect(f.dispatch.mock.calls.map(([line]) => JSON.parse(line))).toEqual(["가🙂", "second", "third"]);
  expect(f.invalid).not.toHaveBeenCalled();
});

it("counts unfinished bytes across chunks before admitting an oversized frame", async () => {
  const f = await fixture(32);
  f.socket.resume();
  const ended = closed(f.socket);
  f.socket.write("x".repeat(20));
  await new Promise(resolve => setTimeout(resolve, 20));
  f.socket.write("x".repeat(13));
  await ended;
  expect(f.tooLarge).toHaveBeenCalledOnce();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it("rejects a fragmented invalid UTF-8 frame without dispatching it", async () => {
  const f = await fixture();
  f.socket.resume();
  const ended = closed(f.socket);
  f.socket.write(Buffer.from([0xc3]));
  await new Promise(resolve => setTimeout(resolve, 20));
  f.socket.write(Buffer.from([0x28, 0x0a]));
  await ended;
  expect(f.invalid).toHaveBeenCalledOnce();
  expect(f.dispatch).not.toHaveBeenCalled();
});
