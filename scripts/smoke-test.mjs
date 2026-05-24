#!/usr/bin/env node

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";

const upstreamPort = 19182;
const routerPort = 19183;
const compactBodies = [];

const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  compactBodies.push(body);
  if (body.service_tier) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: `Unsupported service_tier: ${body.service_tier}` }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, model: body.model, effort: body.reasoning?.effort }));
});

upstream.on("upgrade", (req, socket) => {
  assert.equal(req.url, "/responses");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "upgrade: websocket\r\n" +
      "connection: Upgrade\r\n" +
      "\r\n",
  );
  socket.end();
});

await new Promise((resolve) => upstream.listen(upstreamPort, "127.0.0.1", resolve));

const router = spawn(process.execPath, ["bin/codex-compact-router.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    CODEX_COMPACT_ROUTER_PORT: String(routerPort),
    CODEX_COMPACT_ROUTER_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    CODEX_COMPACT_ROUTER_PROXY: "",
  },
  stdio: ["ignore", "ignore", "pipe"],
});

try {
  await waitForHealth(routerPort);

  const compactResponse = await fetch(`http://127.0.0.1:${routerPort}/responses/compact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "original",
      input: "small input",
      reasoning: { summary: "auto" },
    }),
  });
  assert.equal(compactResponse.status, 200);
  const compactJson = await compactResponse.json();
  assert.equal(compactJson.model, "gpt-5.3-codex");
  assert.equal(compactJson.effort, "low");
  assert.equal(compactBodies.length, 2);
  assert.equal(compactBodies[0].service_tier, "fast");
  assert.equal(Object.hasOwn(compactBodies[1], "service_tier"), false);

  const upgradeResponse = await rawUpgrade(routerPort);
  assert.match(upgradeResponse, /^HTTP\/1\.1 101 Switching Protocols/i);
  await assertRouterStayedAlive(router);

  console.log("smoke tests passed");
} finally {
  router.kill("SIGTERM");
  upstream.close();
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("router health check timed out");
}

function rawUpgrade(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.setTimeout(5000);
    socket.on("connect", () => {
      socket.write(
        "GET /responses HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "\r\n",
      );
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.includes("\r\n\r\n")) {
        socket.write("client data after upstream close");
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("raw upgrade timed out"));
    });
    socket.on("error", reject);
  });
}

async function assertRouterStayedAlive(child) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null);
}
