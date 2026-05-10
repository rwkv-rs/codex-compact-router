#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
SERVICE_NAME="${SERVICE_NAME:-codex-compact-router.service}"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"

if [[ -z "${NODE_BIN}" ]]; then
  echo "node was not found in PATH. Install Node.js 20+ first." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl was not found. This installer requires systemd." >&2
  exit 1
fi

SUDO=()
if [[ "$(id -u)" -ne 0 ]]; then
  SUDO=(sudo)
fi

if command -v npm >/dev/null 2>&1; then
  npm --prefix "${ROOT_DIR}" install --omit=dev
fi

tmp_service="$(mktemp)"
sed \
  -e "s#__PROJECT_DIR__#${ROOT_DIR}#g" \
  -e "s#__NODE_BIN__#${NODE_BIN}#g" \
  "${ROOT_DIR}/systemd/codex-compact-router.service" > "${tmp_service}"

"${SUDO[@]}" install -m 0644 "${tmp_service}" "${SERVICE_PATH}"
rm -f "${tmp_service}"

"${SUDO[@]}" systemctl daemon-reload
"${SUDO[@]}" systemctl enable --now "${SERVICE_NAME}"
"${SUDO[@]}" systemctl --no-pager status "${SERVICE_NAME}"
