import { log } from "./log.mjs";
import {
  bridgeDuplexSockets,
  openWebSocketUpstreamSocket,
  parseStatusCode,
  readHttpHead,
  writeRawHttpRequest,
} from "./proxy.mjs";
import { upstreamWebSocketUrlFor } from "./upstream.mjs";

export async function proxyWebSocketUpgrade(config, req, socket, head) {
  const started = Date.now();
  const target = upstreamWebSocketUrlFor(config, req.url, req.headers.host);
  socket.on("error", () => {});

  try {
    const upstreamSocket = await openWebSocketUpstreamSocket(target, config.proxyUrl);
    upstreamSocket.on("error", () => {});

    writeRawHttpRequest(
      upstreamSocket,
      "GET",
      `${target.pathname}${target.search}`,
      cloneUpgradeHeaders(req.headers, target),
    );

    const { head: upstreamHead, remainder } = await readHttpHead(upstreamSocket);
    const statusCode = parseStatusCode(upstreamHead);
    socket.write(upstreamHead);
    if (remainder.length) {
      socket.write(remainder);
    }
    log(`WS ${new URL(req.url, "http://local").pathname} -> ${statusCode ?? "unknown"} ${Date.now() - started}ms`);

    if (statusCode !== 101) {
      upstreamSocket.pipe(socket);
      upstreamSocket.on("end", () => socket.destroy());
      return;
    }

    if (head?.length) {
      upstreamSocket.write(head);
    }
    bridgeDuplexSockets(upstreamSocket, socket);
  } catch (error) {
    if (!socket.destroyed) {
      socket.write("HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\n\r\n");
      socket.end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
    log(`WS ${new URL(req.url, "http://local").pathname} -> transport_error ${Date.now() - started}ms ${error?.message ?? error}`);
  }
}

function cloneUpgradeHeaders(headers, target) {
  const excluded = new Set(["host"]);
  const next = {};
  for (const [name, headerValue] of Object.entries(headers)) {
    if (!excluded.has(name.toLowerCase()) && headerValue !== undefined) {
      next[name] = Array.isArray(headerValue) ? headerValue.join(", ") : headerValue;
    }
  }
  next.host = target.host;
  return next;
}
