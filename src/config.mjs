import net from "node:net";

import { log } from "./log.mjs";

export async function loadConfig(env = process.env) {
  const modelOrder = listValue(
    env,
    "CODEX_COMPACT_ROUTER_MODELS",
    "CODEX_COMPACT_PROXY_MODELS",
    "gpt-5.3-codex,gpt-5.3-codex-spark,gpt-5.4-mini,gpt-5.2",
  );
  const smallContextModels = new Set(
    listValue(
      env,
      "CODEX_COMPACT_ROUTER_SMALL_CONTEXT_MODELS",
      "CODEX_COMPACT_PROXY_SMALL_MODELS",
      "gpt-5.3-codex-spark",
    ),
  );

  return {
    host: value(env, "CODEX_COMPACT_ROUTER_HOST", "CODEX_COMPACT_PROXY_HOST", "127.0.0.1"),
    port: integerValue(env, "CODEX_COMPACT_ROUTER_PORT", "CODEX_COMPACT_PROXY_PORT", 18181),
    upstreamBase: value(
      env,
      "CODEX_COMPACT_ROUTER_UPSTREAM",
      "CODEX_COMPACT_PROXY_UPSTREAM",
      "https://chatgpt.com/backend-api/codex",
    ),
    requestTimeoutMs: integerValue(
      env,
      "CODEX_COMPACT_ROUTER_TIMEOUT_MS",
      "CODEX_COMPACT_PROXY_TIMEOUT_MS",
      20 * 60 * 1000,
    ),
    maxBodyBytes: integerValue(
      env,
      "CODEX_COMPACT_ROUTER_MAX_BODY_BYTES",
      "CODEX_COMPACT_PROXY_MAX_BODY_BYTES",
      256 * 1024 * 1024,
    ),
    smallModelTokenLimit: integerValue(
      env,
      "CODEX_COMPACT_ROUTER_SMALL_MODEL_TOKEN_LIMIT",
      "CODEX_COMPACT_PROXY_SPARK_TOKEN_LIMIT",
      105000,
    ),
    compactReasoningEffort: value(
      env,
      "CODEX_COMPACT_ROUTER_REASONING_EFFORT",
      "CODEX_COMPACT_PROXY_REASONING_EFFORT",
      "low",
    ),
    compactServiceTier: value(
      env,
      "CODEX_COMPACT_ROUTER_SERVICE_TIER",
      "CODEX_COMPACT_PROXY_SERVICE_TIER",
      "fast",
    ),
    autoOmitUnsupportedServiceTier: booleanValue(
      env,
      "CODEX_COMPACT_ROUTER_AUTO_OMIT_UNSUPPORTED_SERVICE_TIER",
      "CODEX_COMPACT_PROXY_AUTO_OMIT_UNSUPPORTED_SERVICE_TIER",
      true,
    ),
    modelOrder,
    smallContextModels,
    proxyUrl: await resolveProxyUrl(env),
  };
}

function firstEnv(env, ...names) {
  for (const name of names) {
    const raw = env[name];
    if (raw && raw.trim()) {
      return raw.trim();
    }
  }
  return undefined;
}

function value(env, primary, legacy, fallback) {
  return firstEnv(env, primary, legacy) ?? fallback;
}

function integerValue(env, primary, legacy, fallback) {
  const raw = firstEnv(env, primary, legacy);
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanValue(env, primary, legacy, fallback) {
  const raw = firstEnv(env, primary, legacy);
  if (!raw) {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

function listValue(env, primary, legacy, fallback) {
  return value(env, primary, legacy, fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function resolveProxyUrl(env) {
  const explicit = firstPresentEnv(env, "CODEX_COMPACT_ROUTER_PROXY", "CODEX_COMPACT_PROXY_PROXY");
  if (explicit) {
    return await normalizeProxySetting(env, explicit.value, explicit.name, true);
  }

  const inherited = firstPresentEnv(
    env,
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  );
  if (!inherited) {
    return undefined;
  }

  return await normalizeProxySetting(env, inherited.value, inherited.name, false);
}

function firstPresentEnv(env, ...names) {
  for (const name of names) {
    if (Object.hasOwn(env, name)) {
      return { name, value: env[name] ?? "" };
    }
  }
  return undefined;
}

async function normalizeProxySetting(env, rawValue, sourceName, explicit) {
  const raw = rawValue.trim();
  const lowered = raw.toLowerCase();
  if (!raw || ["0", "false", "no", "off", "none", "direct"].includes(lowered)) {
    if (explicit) {
      log(`${sourceName} disables upstream proxy`);
    }
    return undefined;
  }
  if (lowered !== "auto") {
    return normalizeProxyUrl(raw, sourceName, explicit);
  }

  const candidates = listValue(
    env,
    "CODEX_COMPACT_ROUTER_AUTO_PROXY_CANDIDATES",
    "CODEX_COMPACT_PROXY_AUTO_PROXY_CANDIDATES",
    "http://127.0.0.1:7890",
  );
  for (const candidate of candidates) {
    if (await canConnectToProxy(candidate)) {
      return candidate;
    }
  }
  log(`no auto proxy candidate is reachable; using direct upstream connection`);
  return undefined;
}

function normalizeProxyUrl(raw, sourceName, explicit) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return handleProxyConfigError(`${sourceName} has invalid upstream proxy URL ${raw}`, explicit);
  }
  if (!isHttpProxyProtocol(url.protocol)) {
    return handleProxyConfigError(`${sourceName} uses unsupported upstream proxy protocol ${url.protocol}`, explicit);
  }
  return url.toString();
}

function handleProxyConfigError(message, explicit) {
  if (explicit) {
    throw new Error(message);
  }
  log(`${message}; ignoring inherited proxy`);
  return undefined;
}

function isHttpProxyProtocol(protocol) {
  return protocol === "http:" || protocol === "https:";
}

function canConnectToProxy(raw) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(raw);
    } catch {
      log(`skipping invalid auto proxy candidate ${raw}`);
      resolve(false);
      return;
    }
    if (!isHttpProxyProtocol(url.protocol)) {
      log(`skipping unsupported auto proxy candidate ${raw}`);
      resolve(false);
      return;
    }

    const port = Number.parseInt(url.port || (url.protocol === "https:" ? "443" : "80"), 10);
    const socket = net.connect({ host: url.hostname, port });
    const done = (result) => {
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
      resolve(result);
    };
    socket.setTimeout(300);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
