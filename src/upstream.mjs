export function isCompactEndpoint(pathname) {
  const normalized = pathname.replace(/^\/v1(?=\/|$)/, "");
  return normalized === "/responses/compact";
}

export function upstreamUrlFor(config, requestUrl, hostHeader) {
  const incoming = new URL(requestUrl, `http://${hostHeader ?? `${config.host}:${config.port}`}`);
  const base = config.upstreamBase.replace(/\/+$/, "");
  const endpoint = incoming.pathname.replace(/^\/v1(?=\/|$)/, "") || "/";
  return new URL(`${base}${endpoint}${incoming.search}`);
}

export function upstreamWebSocketUrlFor(config, requestUrl, hostHeader) {
  const target = upstreamUrlFor(config, requestUrl, hostHeader);
  if (target.protocol === "https:") {
    target.protocol = "wss:";
  } else if (target.protocol === "http:") {
    target.protocol = "ws:";
  }
  return target;
}
