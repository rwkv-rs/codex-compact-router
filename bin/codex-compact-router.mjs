#!/usr/bin/env node

import http from "node:http";
import { Readable } from "node:stream";

const env = process.env;

const HOST = value("CODEX_COMPACT_ROUTER_HOST", "CODEX_COMPACT_PROXY_HOST", "127.0.0.1");
const PORT = integerValue("CODEX_COMPACT_ROUTER_PORT", "CODEX_COMPACT_PROXY_PORT", 18181);
const UPSTREAM_BASE = value(
  "CODEX_COMPACT_ROUTER_UPSTREAM",
  "CODEX_COMPACT_PROXY_UPSTREAM",
  "https://chatgpt.com/backend-api/codex",
);
const REQUEST_TIMEOUT_MS = integerValue(
  "CODEX_COMPACT_ROUTER_TIMEOUT_MS",
  "CODEX_COMPACT_PROXY_TIMEOUT_MS",
  20 * 60 * 1000,
);
const MAX_BODY_BYTES = integerValue(
  "CODEX_COMPACT_ROUTER_MAX_BODY_BYTES",
  "CODEX_COMPACT_PROXY_MAX_BODY_BYTES",
  256 * 1024 * 1024,
);
const SMALL_MODEL_TOKEN_LIMIT = integerValue(
  "CODEX_COMPACT_ROUTER_SMALL_MODEL_TOKEN_LIMIT",
  "CODEX_COMPACT_PROXY_SPARK_TOKEN_LIMIT",
  105000,
);
const COMPACT_REASONING_EFFORT = value(
  "CODEX_COMPACT_ROUTER_REASONING_EFFORT",
  "CODEX_COMPACT_PROXY_REASONING_EFFORT",
  "low",
);
const COMPACT_SERVICE_TIER = value(
  "CODEX_COMPACT_ROUTER_SERVICE_TIER",
  "CODEX_COMPACT_PROXY_SERVICE_TIER",
  "fast",
);
const MODEL_ORDER = listValue(
  "CODEX_COMPACT_ROUTER_MODELS",
  "CODEX_COMPACT_PROXY_MODELS",
  "gpt-5.3-codex,gpt-5.3-codex-spark,gpt-5.4-mini,gpt-5.2",
);
const SMALL_CONTEXT_MODELS = new Set(
  listValue(
    "CODEX_COMPACT_ROUTER_SMALL_CONTEXT_MODELS",
    "CODEX_COMPACT_PROXY_SMALL_MODELS",
    "gpt-5.3-codex-spark",
  ),
);
const PROXY_URL = firstEnv("CODEX_COMPACT_ROUTER_PROXY", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy");

await configureProxyDispatcher();

function firstEnv(...names) {
  for (const name of names) {
    const raw = env[name];
    if (raw && raw.trim()) {
      return raw.trim();
    }
  }
  return undefined;
}

function value(primary, legacy, fallback) {
  return firstEnv(primary, legacy) ?? fallback;
}

function integerValue(primary, legacy, fallback) {
  const raw = firstEnv(primary, legacy);
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function listValue(primary, legacy, fallback) {
  return value(primary, legacy, fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function configureProxyDispatcher() {
  if (!PROXY_URL) {
    return;
  }
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(PROXY_URL));
    log(`using upstream proxy ${redactProxy(PROXY_URL)}`);
  } catch (error) {
    log(`failed to enable upstream proxy: ${error?.message ?? error}`);
  }
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

function log(message) {
  console.error(`${new Date().toISOString()} ${message}`);
}

function isCompactEndpoint(pathname) {
  const normalized = pathname.replace(/^\/v1(?=\/|$)/, "");
  return normalized === "/responses/compact";
}

function upstreamUrlFor(requestUrl, hostHeader) {
  const incoming = new URL(requestUrl, `http://${hostHeader ?? `${HOST}:${PORT}`}`);
  const base = UPSTREAM_BASE.replace(/\/+$/, "");
  const endpoint = incoming.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  return new URL(`${base}${endpoint}${incoming.search}`);
}

function cloneForwardHeaders(headers) {
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

function cloneResponseHeaders(headers) {
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

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function estimateTokensFromBody(bodyBuffer, requestJson) {
  const input = requestJson && typeof requestJson === "object" ? requestJson.input : undefined;
  const bytes = input === undefined ? bodyBuffer.length : Buffer.byteLength(JSON.stringify(input));
  return Math.ceil(bytes / 4);
}

function compactModelOrder(estimatedTokens) {
  const ordered = [];
  for (const model of MODEL_ORDER) {
    if (SMALL_CONTEXT_MODELS.has(model) && estimatedTokens > SMALL_MODEL_TOKEN_LIMIT) {
      continue;
    }
    ordered.push(model);
  }
  return [...new Set(ordered)];
}

function compactBodyForModel(baseRequest, model) {
  return Buffer.from(
    JSON.stringify({
      ...baseRequest,
      model,
      service_tier: COMPACT_SERVICE_TIER,
      reasoning: {
        ...(baseRequest.reasoning ?? {}),
        effort: COMPACT_REASONING_EFFORT,
      },
    }),
  );
}

async function fetchUpstream(url, method, headers, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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

async function forwardOnce(req, res, bodyBuffer) {
  const started = Date.now();
  const url = upstreamUrlFor(req.url, req.headers.host);
  const response = await fetchUpstream(
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

async function forwardCompact(req, res, bodyBuffer) {
  let baseRequest;
  try {
    baseRequest = JSON.parse(bodyBuffer.toString("utf8"));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "compact router received invalid JSON" }));
    return;
  }

  const estimatedTokens = estimateTokensFromBody(bodyBuffer, baseRequest);
  const models = compactModelOrder(estimatedTokens);
  const url = upstreamUrlFor(req.url, req.headers.host);
  const headers = {
    ...cloneForwardHeaders(req.headers),
    "content-type": "application/json",
  };

  let lastStatus = 502;
  let lastHeaders = { "content-type": "application/json" };
  let lastBody = Buffer.from(JSON.stringify({ error: "compact router exhausted all model fallbacks" }));

  for (const model of models) {
    const started = Date.now();
    const attemptBody = compactBodyForModel(baseRequest, model);
    try {
      const response = await fetchUpstream(url, req.method, headers, attemptBody);
      const responseBody = Buffer.from(await response.arrayBuffer());
      log(
        `compact model=${model} estimated_tokens=${estimatedTokens} -> ${response.status} ${Date.now() - started}ms`,
      );
      if (response.ok) {
        res.writeHead(response.status, {
          ...cloneResponseHeaders(response.headers),
          "x-codex-compact-router-model": model,
        });
        res.end(responseBody);
        return;
      }
      lastStatus = response.status;
      lastHeaders = cloneResponseHeaders(response.headers);
      lastBody = responseBody;
      if (response.status === 401 || response.status === 403) {
        break;
      }
    } catch (error) {
      log(`compact model=${model} estimated_tokens=${estimatedTokens} -> transport_error ${Date.now() - started}ms`);
      lastStatus = 502;
      lastHeaders = { "content-type": "application/json" };
      lastBody = Buffer.from(JSON.stringify({ error: String(error?.message ?? error) }));
    }
  }

  res.writeHead(lastStatus, {
    ...lastHeaders,
    "x-codex-compact-router-models-tried": models.join(","),
  });
  res.end(lastBody);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        upstream: UPSTREAM_BASE,
        compact_models: MODEL_ORDER,
        small_context_models: [...SMALL_CONTEXT_MODELS],
        small_model_token_limit: SMALL_MODEL_TOKEN_LIMIT,
        service_tier: COMPACT_SERVICE_TIER,
        reasoning_effort: COMPACT_REASONING_EFFORT,
      }),
    );
    return;
  }

  try {
    const bodyBuffer = await readBody(req);
    const pathname = new URL(req.url, "http://local").pathname;
    if (req.method === "POST" && isCompactEndpoint(pathname)) {
      await forwardCompact(req, res, bodyBuffer);
    } else {
      await forwardOnce(req, res, bodyBuffer);
    }
  } catch (error) {
    const statusCode = error?.statusCode ?? 502;
    res.writeHead(statusCode, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(error?.message ?? error) }));
  }
});

server.listen(PORT, HOST, () => {
  log(
    `codex compact router listening on http://${HOST}:${PORT}; upstream=${UPSTREAM_BASE}; models=${MODEL_ORDER.join(">")}; small_limit=${SMALL_MODEL_TOKEN_LIMIT}; effort=${COMPACT_REASONING_EFFORT}; tier=${COMPACT_SERVICE_TIER}`,
  );
});
