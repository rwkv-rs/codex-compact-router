import { log } from "./log.mjs";
import { cloneForwardHeaders, cloneResponseHeaders, fetchUpstream } from "./http-forward.mjs";
import { upstreamUrlFor } from "./upstream.mjs";

export async function forwardCompact(config, req, res, bodyBuffer) {
  let baseRequest;
  try {
    baseRequest = JSON.parse(bodyBuffer.toString("utf8"));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "compact router received invalid JSON" }));
    return;
  }

  const estimatedTokens = estimateTokensFromBody(bodyBuffer, baseRequest);
  const models = compactModelOrder(config, estimatedTokens);
  const url = upstreamUrlFor(config, req.url, req.headers.host);
  const headers = {
    ...cloneForwardHeaders(req.headers),
    "content-type": "application/json",
  };

  let lastStatus = 502;
  let lastHeaders = { "content-type": "application/json" };
  let lastBody = Buffer.from(JSON.stringify({ error: "compact router exhausted all model fallbacks" }));
  let includeServiceTier = Boolean(config.compactServiceTier && config.compactServiceTier !== "none");
  let stopFallback = false;

  for (const model of models) {
    for (;;) {
      const started = Date.now();
      const attemptBody = compactBodyForModel(config, baseRequest, model, includeServiceTier);
      const tierLabel = includeServiceTier ? config.compactServiceTier : "omitted";
      try {
        const response = await fetchUpstream(config, url, req.method, headers, attemptBody);
        const responseBody = Buffer.from(await response.arrayBuffer());
        log(
          `compact model=${model} tier=${tierLabel} estimated_tokens=${estimatedTokens} -> ${response.status} ${Date.now() - started}ms`,
        );
        if (response.ok) {
          res.writeHead(response.status, {
            ...cloneResponseHeaders(response.headers),
            "x-codex-compact-router-model": model,
            "x-codex-compact-router-service-tier": tierLabel,
          });
          res.end(responseBody);
          return;
        }
        if (
          includeServiceTier &&
          config.autoOmitUnsupportedServiceTier &&
          isUnsupportedServiceTier(response.status, responseBody)
        ) {
          includeServiceTier = false;
          log(`compact upstream rejected service_tier=${config.compactServiceTier}; retrying without service_tier`);
          continue;
        }
        lastStatus = response.status;
        lastHeaders = cloneResponseHeaders(response.headers);
        lastBody = responseBody;
        if (response.status === 401 || response.status === 403) {
          stopFallback = true;
          break;
        }
      } catch (error) {
        log(`compact model=${model} tier=${tierLabel} estimated_tokens=${estimatedTokens} -> transport_error ${Date.now() - started}ms`);
        lastStatus = 502;
        lastHeaders = { "content-type": "application/json" };
        lastBody = Buffer.from(JSON.stringify({ error: String(error?.message ?? error) }));
      }
      break;
    }
    if (stopFallback) {
      break;
    }
  }

  res.writeHead(lastStatus, {
    ...lastHeaders,
    "x-codex-compact-router-models-tried": models.join(","),
  });
  res.end(lastBody);
}

function estimateTokensFromBody(bodyBuffer, requestJson) {
  const input = requestJson && typeof requestJson === "object" ? requestJson.input : undefined;
  const bytes = input === undefined ? bodyBuffer.length : Buffer.byteLength(JSON.stringify(input));
  return Math.ceil(bytes / 4);
}

function compactModelOrder(config, estimatedTokens) {
  const ordered = [];
  for (const model of config.modelOrder) {
    if (config.smallContextModels.has(model) && estimatedTokens > config.smallModelTokenLimit) {
      continue;
    }
    ordered.push(model);
  }
  return [...new Set(ordered)];
}

function compactBodyForModel(config, baseRequest, model, includeServiceTier) {
  const payload = {
    ...baseRequest,
    model,
    reasoning: {
      ...(baseRequest.reasoning ?? {}),
      effort: config.compactReasoningEffort,
    },
  };
  if (includeServiceTier && config.compactServiceTier && config.compactServiceTier !== "none") {
    payload.service_tier = config.compactServiceTier;
  } else {
    delete payload.service_tier;
  }
  return Buffer.from(
    JSON.stringify(payload),
  );
}

function isUnsupportedServiceTier(status, responseBody) {
  if (status < 400 || responseBody.length === 0) {
    return false;
  }
  const text = responseBody.toString("utf8");
  try {
    const parsed = JSON.parse(text);
    const fields = [parsed.detail, parsed.error, parsed.message, parsed?.error?.message]
      .filter(Boolean)
      .map(String);
    return fields.some((field) => field.includes("Unsupported service_tier"));
  } catch {
    return text.includes("Unsupported service_tier");
  }
}
