import { Readable } from "node:stream";

import { log } from "./log.mjs";
import { upstreamUrlFor } from "./upstream.mjs";

export function cloneForwardHeaders(headers) {
  const excluded = new Set([
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "accept-encoding",
  ]);
  const next = {};
  for (const [name, headerValue] of Object.entries(headers)) {
    if (!excluded.has(name.toLowerCase()) && headerValue !== undefined) {
      next[name] = Array.isArray(headerValue) ? headerValue.join(", ") : headerValue;
    }
  }
  return next;
}

export function cloneResponseHeaders(headers) {
  const excluded = new Set([
    "connection",
    "content-encoding",
    "content-length",
    "transfer-encoding",
  ]);
  const next = {};
  for (const [name, headerValue] of headers.entries()) {
    if (!excluded.has(name.toLowerCase())) {
      next[name] = headerValue;
    }
  }
  return next;
}

export async function readBody(req, maxBodyBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      const error = new Error(`request body exceeds ${maxBodyBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function fetchUpstream(config, url, method, headers, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    return await fetch(url, {
      method,
      headers,
      body: body.length === 0 ? undefined : body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function forwardOnce(config, req, res, bodyBuffer) {
  const started = Date.now();
  const url = upstreamUrlFor(config, req.url, req.headers.host);
  const response = await fetchUpstream(
    config,
    url,
    req.method,
    cloneForwardHeaders(req.headers),
    bodyBuffer,
  );
  res.writeHead(response.status, cloneResponseHeaders(response.headers));
  if (response.body) {
    Readable.fromWeb(response.body).pipe(res);
  } else {
    res.end();
  }
  log(`${req.method} ${new URL(req.url, "http://local").pathname} -> ${response.status} ${Date.now() - started}ms`);
}
