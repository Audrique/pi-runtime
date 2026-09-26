import assert from "node:assert/strict";
import { once, getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { requestHerdr } from "../extensions/herdr-client.ts";

type WireRequest = { id: string; method: string; params: Record<string, unknown> };

async function fixture(t: TestContext, respond: (socket: Socket, request: WireRequest) => void) {
  const directory = await mkdtemp(join(tmpdir(), "herdr-"));
  const endpoint = join(directory, "rpc.sock");
  const requests: WireRequest[] = [];
  const connections: { socket: Socket; closed: Promise<void> }[] = [];
  const server = createServer(socket => {
    // Discard writes arriving after the client deliberately destroys its connection.
    socket.on("error", () => {});
    connections.push({ socket, closed: new Promise(resolve => socket.once("close", () => resolve())) });
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      input += chunk;
      let newline: number;
      while ((newline = input.indexOf("\n")) !== -1) {
        const request = JSON.parse(input.slice(0, newline)) as WireRequest;
        input = input.slice(newline + 1);
        requests.push(request);
        respond(socket, request);
      }
    });
  });
  t.after(async () => {
    for (const { socket } of connections) socket.destroy();
    try {
      if (server.listening) await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  server.listen(endpoint);
  await once(server, "listening");
  return {
    endpoint, requests, connections,
    async assertClean(signal: AbortSignal) {
      assert.equal(getEventListeners(signal, "abort").length, 0, "abort listener removed");
      await Promise.all(connections.map(connection => connection.closed));
      assert.ok(connections.every(connection => connection.socket.destroyed), "client disconnected");
    },
  };
}

const request = { method: "test.method", params: { value: 42 } };
const options = { timeout: 3000 };

function ack(socket: Socket, id: string, result: unknown) {
  socket.write(JSON.stringify({ id, result }) + "\n");
}

test("sends a newline request with a random id and accepts fragmented UTF-8 acknowledgement", options, async t => {
  const expected = { ok: true, label: "héllo" };
  const f = await fixture(t, (socket, { id }) => {
    const response = Buffer.from(JSON.stringify({ id, result: expected }) + "\n");
    const split = response.indexOf(Buffer.from("é")) + 1;
    socket.write(response.subarray(0, split));
    setImmediate(() => {
      socket.write(response.subarray(split, -1));
      setImmediate(() => socket.write(response.subarray(-1)));
    });
  });
  const controller = new AbortController();
  assert.deepEqual(await requestHerdr(f.endpoint, request, controller.signal), expected);
  assert.deepEqual(await requestHerdr(f.endpoint, request, controller.signal), expected);
  assert.equal(f.requests.length, 2);
  for (const sent of f.requests) {
    assert.equal(sent.method, request.method);
    assert.deepEqual(sent.params, request.params);
    assert.match(sent.id, /^[0-9a-f-]{36}$/i);
  }
  assert.notEqual(f.requests[0].id, f.requests[1].id);
  await f.assertClean(controller.signal);
});

test("skips unrelated ids, including errors, and ignores data after the matching response", options, async t => {
  const f = await fixture(t, (socket, { id }) => {
    socket.write(JSON.stringify({ id: "other", error: { message: "ignore" } }) + "\n"
      + JSON.stringify({ id: "also-other", result: { unexpected: true } }) + "\n"
      + JSON.stringify({ id, result: { ok: true } }) + "\nnot JSON\n");
  });
  const controller = new AbortController();
  assert.deepEqual(await requestHerdr(f.endpoint, request, controller.signal), { ok: true });
  await f.assertClean(controller.signal);
});

for (const error of [{ code: 123, message: "operation failed" }, "operation failed"]) {
  test(`rejects error acknowledgements (${typeof error})`, options, async t => {
    const f = await fixture(t, (socket, { id }) => socket.write(JSON.stringify({ id, error }) + "\n"));
    const controller = new AbortController();
    await assert.rejects(requestHerdr(f.endpoint, request, controller.signal), /operation failed/);
    await f.assertClean(controller.signal);
  });
}

for (const result of [null, [], "wrong", 1, undefined]) {
  test(`rejects matching acknowledgement with invalid result ${JSON.stringify(result)}`, options, async t => {
    const f = await fixture(t, (socket, { id }) => ack(socket, id, result));
    const controller = new AbortController();
    await assert.rejects(requestHerdr(f.endpoint, request, controller.signal), /result must be an object/);
    await f.assertClean(controller.signal);
  });
}

test("rejects malformed JSON", options, async t => {
  const f = await fixture(t, socket => socket.write("{broken\n"));
  const controller = new AbortController();
  await assert.rejects(requestHerdr(f.endpoint, request, controller.signal), /Malformed JSON/);
  await f.assertClean(controller.signal);
});

test("times out without retrying and cleans up", options, async t => {
  const f = await fixture(t, () => {});
  const controller = new AbortController();
  await assert.rejects(requestHerdr(f.endpoint, request, controller.signal, 50), /timed out after 50ms/);
  await f.assertClean(controller.signal);
  assert.equal(f.requests.length, 1);
});

test("default timeout is 1000ms", options, async t => {
  const f = await fixture(t, () => {});
  await assert.rejects(requestHerdr(f.endpoint, request), /timed out after 1000ms/);
});

for (const close of ["end", "destroy"] as const) {
  test(`rejects early ${close}, including an unterminated response`, options, async t => {
    const f = await fixture(t, (socket, { id }) => {
      socket.write(JSON.stringify({ id, result: {} }));
      socket[close]();
    });
    const controller = new AbortController();
    await assert.rejects(requestHerdr(f.endpoint, request, controller.signal), /connection (ended|closed)/);
    await f.assertClean(controller.signal);
  });
}

test("rejects socket connection errors and removes the abort listener", options, async t => {
  const f = await fixture(t, () => {});
  const controller = new AbortController();
  await assert.rejects(requestHerdr(join(f.endpoint, "missing"), request, controller.signal), /ENOTDIR|ENOENT/);
  await f.assertClean(controller.signal);
  assert.equal(f.connections.length, 0);
});

test("aborts an active request and disconnects", options, async t => {
  const controller = new AbortController();
  const reason = new Error("cancelled by test");
  const f = await fixture(t, () => controller.abort(reason));
  await assert.rejects(requestHerdr(f.endpoint, request, controller.signal), error => error === reason);
  await f.assertClean(controller.signal);
  assert.equal(f.requests.length, 1);
});

test("already aborted signals reject without opening a connection", options, async t => {
  const f = await fixture(t, () => {});
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requestHerdr(f.endpoint, request, controller.signal), { name: "AbortError" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.connections.length, 0);
  await f.assertClean(controller.signal);
});

for (const newline of [false, true]) {
  test(`rejects oversized fragmented response (newline=${newline})`, options, async t => {
    const f = await fixture(t, socket => {
      socket.write(" ".repeat(32 * 1024));
      setImmediate(() => socket.write(" ".repeat(32 * 1024 + 1) + (newline ? "\n" : "")));
    });
    const controller = new AbortController();
    await assert.rejects(requestHerdr(f.endpoint, request, controller.signal), /exceeds 64 KiB/);
    await f.assertClean(controller.signal);
  });
}

test("allows a response exactly at the 64 KiB line limit", options, async t => {
  let expected: Record<string, unknown>;
  const f = await fixture(t, (socket, { id }) => {
    const overhead = Buffer.byteLength(JSON.stringify({ id, result: { text: "" } }));
    expected = { text: "x".repeat(64 * 1024 - overhead) };
    ack(socket, id, expected);
  });
  const controller = new AbortController();
  const result = await requestHerdr(f.endpoint, request, controller.signal);
  assert.deepEqual(result, expected!);
  await f.assertClean(controller.signal);
});

test("serialization failures do not open a socket or install abort listeners", options, async t => {
  const f = await fixture(t, () => {});
  const controller = new AbortController();
  const params: Record<string, unknown> = {};
  params.self = params;
  await assert.rejects(requestHerdr(f.endpoint, { method: "circular", params }, controller.signal), /circular/i);
  assert.equal(f.connections.length, 0);
  await f.assertClean(controller.signal);
});
