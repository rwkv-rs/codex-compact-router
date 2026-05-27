import net from "node:net";
import tls from "node:tls";

import { log } from "./log.mjs";

export async function configureProxyDispatcher(proxyUrl) {
  if (!proxyUrl) {
    return;
  }
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    log(`using upstream proxy ${redactProxy(proxyUrl)}`);
  } catch (error) {
    log(`failed to enable upstream proxy: ${error?.message ?? error}`);
  }
}

export function writeRawHttpRequest(socket, method, path, headers) {
  socket.write(`${method} ${path} HTTP/1.1\r\n`);
  for (const [name, headerValue] of Object.entries(headers)) {
    if (Array.isArray(headerValue)) {
      for (const value of headerValue) {
        socket.write(`${name}: ${value}\r\n`);
      }
    } else if (headerValue !== undefined) {
      socket.write(`${name}: ${headerValue}\r\n`);
    }
  }
  socket.write("\r\n");
}

export function bridgeDuplexSockets(left, right) {
  let closed = false;
  const closeBoth = () => {
    if (closed) {
      return;
    }
    closed = true;
    left.unpipe(right);
    right.unpipe(left);
    if (!left.destroyed) {
      left.destroy();
    }
    if (!right.destroyed) {
      right.destroy();
    }
  };
  left.on("error", closeBoth);
  right.on("error", closeBoth);
  left.on("end", closeBoth);
  right.on("end", closeBoth);
  left.on("close", closeBoth);
  right.on("close", closeBoth);
  left.pipe(right);
  right.pipe(left);
}

export function readHttpHead(socket) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      const buffer = Buffer.concat(chunks, total);
      const marker = buffer.indexOf("\r\n\r\n");
      if (marker === -1) {
        return;
      }
      cleanup();
      resolve({
        head: buffer.subarray(0, marker + 4),
        remainder: buffer.subarray(marker + 4),
      });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("socket ended before HTTP headers completed"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

export function parseStatusCode(responseHead) {
  const endOfLine = responseHead.indexOf("\r\n");
  const firstLine = responseHead.toString("latin1", 0, endOfLine === -1 ? undefined : endOfLine);
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i.exec(firstLine);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

export async function openWebSocketUpstreamSocket(target, proxyUrl) {
  let socket;
  if (proxyUrl) {
    socket = await openHttpConnectTunnel(target, proxyUrl);
  } else {
    const port = Number.parseInt(target.port || (target.protocol === "wss:" ? "443" : "80"), 10);
    socket = await connectNetSocket({ host: target.hostname, port });
  }

  if (target.protocol !== "wss:") {
    return socket;
  }

  return await connectTlsSocket({
    socket,
    servername: target.hostname,
    ALPNProtocols: ["http/1.1"],
  });
}

function redactProxy(raw) {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
    }
    return url.toString();
  } catch {
    return raw.replace(/\/\/[^@/\s]+@/, "//***@");
  }
}

function connectNetSocket(options) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(options);
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

function connectTlsSocket(options) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(options);
    const cleanup = () => {
      socket.off("secureConnect", onSecureConnect);
      socket.off("error", onError);
    };
    const onSecureConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.once("secureConnect", onSecureConnect);
    socket.once("error", onError);
  });
}

async function openHttpConnectTunnel(target, proxyUrl) {
  const proxy = new URL(proxyUrl);
  const proxyPort = Number.parseInt(proxy.port || (proxy.protocol === "https:" ? "443" : "80"), 10);
  const socket = proxy.protocol === "https:"
    ? await connectTlsSocket({
        host: proxy.hostname,
        port: proxyPort,
        servername: proxy.hostname,
        ALPNProtocols: ["http/1.1"],
      })
    : await connectNetSocket({ host: proxy.hostname, port: proxyPort });

  const targetPort = target.port || (target.protocol === "wss:" ? "443" : "80");
  const authority = `${target.hostname}:${targetPort}`;
  const headers = {
    host: authority,
    "proxy-connection": "keep-alive",
  };
  const authorization = proxyAuthorizationHeader(proxy);
  if (authorization) {
    headers["proxy-authorization"] = authorization;
  }
  writeRawHttpRequest(socket, "CONNECT", authority, headers);

  const { head, remainder } = await readHttpHead(socket);
  const statusCode = parseStatusCode(head);
  if (statusCode === undefined || statusCode < 200 || statusCode >= 300) {
    socket.destroy();
    throw new Error(`proxy CONNECT ${authority} failed with status ${statusCode ?? "unknown"}`);
  }
  if (remainder.length) {
    socket.unshift(remainder);
  }
  return socket;
}

function proxyAuthorizationHeader(proxy) {
  if (!proxy.username && !proxy.password) {
    return undefined;
  }
  return `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
}
