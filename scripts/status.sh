#!/usr/bin/env bash
set -euo pipefail

HOST="${CODEX_COMPACT_ROUTER_HOST:-127.0.0.1}"
PORT="${CODEX_COMPACT_ROUTER_PORT:-18181}"
SERVICE_NAME="${SERVICE_NAME:-codex-compact-router.service}"

systemctl --no-pager show "${SERVICE_NAME}" \
  -p ActiveState \
  -p SubState \
  -p MainPID \
  -p FragmentPath || true

echo
curl -fsS "http://${HOST}:${PORT}/healthz"
echo

echo
tail -n 40 /var/log/codex-compact-router.log 2>/dev/null || true
