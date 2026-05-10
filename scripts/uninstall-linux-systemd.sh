#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-codex-compact-router.service}"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"

SUDO=()
if [[ "$(id -u)" -ne 0 ]]; then
  SUDO=(sudo)
fi

"${SUDO[@]}" systemctl disable --now "${SERVICE_NAME}" 2>/dev/null || true
"${SUDO[@]}" rm -f "${SERVICE_PATH}"
"${SUDO[@]}" systemctl daemon-reload
echo "removed ${SERVICE_NAME}"
