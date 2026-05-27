import http from "node:http";

import { forwardCompact } from "./compact.mjs";
import { forwardOnce, readBody } from "./http-forward.mjs";
import { isCompactEndpoint } from "./upstream.mjs";
import { proxyWebSocketUpgrade } from "./websocket-forward.mjs";

export function createCodexCompactRouter(config) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(healthPayload(config)));
      return;
    }

    try {
      const bodyBuffer = await readBody(req, config.maxBodyBytes);
      const pathname = new URL(req.url, "http://local").pathname;
      if (req.method === "POST" && isCompactEndpoint(pathname)) {
        await forwardCompact(config, req, res, bodyBuffer);
      } else {
        await forwardOnce(config, req, res, bodyBuffer);
      }
    } catch (error) {
      const statusCode = error?.statusCode ?? 502;
      res.writeHead(statusCode, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
  });

  server.on("upgrade", (req, socket, head) => {
    void proxyWebSocketUpgrade(config, req, socket, head);
  });

  return server;
}

function healthPayload(config) {
  return {
    ok: true,
    upstream: config.upstreamBase,
    compact_models: config.modelOrder,
    small_context_models: [...config.smallContextModels],
    small_model_token_limit: config.smallModelTokenLimit,
    service_tier: config.compactServiceTier,
    auto_omit_unsupported_service_tier: config.autoOmitUnsupportedServiceTier,
    reasoning_effort: config.compactReasoningEffort,
    upstream_proxy_configured: Boolean(config.proxyUrl),
  };
}
