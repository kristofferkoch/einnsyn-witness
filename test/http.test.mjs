// Tests for lib/http.mjs — the IPv4-pinned, retrying POST client.
//
// Why this module exists: einnsyn.no began publishing an AAAA record whose v6
// route is unreachable from both this VM and GitHub runners. Node fetch's
// happy-eyeballs latches onto the dead v6 address and fails without falling
// back (surfaces as ETIMEDOUT). Pinning DNS to the A record fixes it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { postJson } from "../lib/http.mjs";

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://localhost:${server.address().port}/api`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("resolves parsed JSON on 2xx", async () => {
  const s = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, echo: req.headers["content-length"] }));
  });
  try {
    const data = await postJson(s.url, { body: { size: 1 }, retries: 1 });
    assert.deepEqual(data, { ok: true, echo: "10" });
  } finally {
    await s.close();
  }
});

test("pins IPv4: succeeds against a v4-only server via a dual-stack hostname", async () => {
  // Server listens ONLY on 127.0.0.1; the client must ask DNS for the A
  // record and never attempt ::1, or this would hang/fail.
  const s = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  try {
    await postJson(s.url, { body: {}, retries: 1, timeoutMs: 3000 });
  } finally {
    await s.close();
  }
});

test("retries on connection reset, then succeeds", async () => {
  let connections = 0;
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  server.on("connection", (sock) => {
    connections += 1;
    if (connections < 3) sock.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://localhost:${server.address().port}/api`;
  try {
    await postJson(url, { body: {}, retries: 3, timeoutMs: 3000 });
    assert.equal(connections, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("retries on 503, then succeeds", async () => {
  let requests = 0;
  const s = await startServer((req, res) => {
    requests += 1;
    if (requests === 1) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("busy");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    }
  });
  try {
    const data = await postJson(s.url, { body: {}, retries: 3, timeoutMs: 3000 });
    assert.deepEqual(data, { ok: true });
    assert.equal(requests, 2);
  } finally {
    await s.close();
  }
});

test("does not retry a 4xx and reports the status", async () => {
  let requests = 0;
  const s = await startServer((req, res) => {
    requests += 1;
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad request");
  });
  try {
    await assert.rejects(
      postJson(s.url, { body: {}, retries: 3, timeoutMs: 3000 }),
      (err) => err.statusCode === 400 && /HTTP 400/.test(err.message),
    );
    assert.equal(requests, 1);
  } finally {
    await s.close();
  }
});

test("times out a non-responding server with ETIMEDOUT", async () => {
  const s = await startServer(() => {
    /* accept, never respond */
  });
  try {
    await assert.rejects(
      postJson(s.url, { body: {}, retries: 1, timeoutMs: 300 }),
      (err) => err.code === "ETIMEDOUT" && /timeout after 300ms/.test(err.message),
    );
  } finally {
    await s.close();
  }
});

test("rejects invalid JSON on 2xx without retrying into success", async () => {
  let requests = 0;
  const s = await startServer((req, res) => {
    requests += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("not json");
  });
  try {
    await assert.rejects(
      postJson(s.url, { body: {}, retries: 3, timeoutMs: 3000 }),
      /invalid JSON/,
    );
    assert.equal(requests, 1);
  } finally {
    await s.close();
  }
});
