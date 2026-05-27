#!/usr/bin/env node

import { loadConfig } from "../src/config.mjs";
import { log } from "../src/log.mjs";
import { configureProxyDispatcher } from "../src/proxy.mjs";
import { createCodexCompactRouter } from "../src/server.mjs";

const config = await loadConfig();
await configureProxyDispatcher(config.proxyUrl);

const server = createCodexCompactRouter(config);
server.listen(config.port, config.host, () => {
  log(
    `codex compact router listening on http://${config.host}:${config.port}; upstream=${config.upstreamBase}; models=${config.modelOrder.join(">")}; small_limit=${config.smallModelTokenLimit}; effort=${config.compactReasoningEffort}; tier=${config.compactServiceTier}`,
  );
});
