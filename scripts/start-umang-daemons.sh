#!/usr/bin/env bash
# ============================================================================
# KA-POSONG, LINKA & UMANG CORE DAEMON MANAGER (scripts/start-umang-daemons.sh)
# ============================================================================
# Manages the production-hardened integration stack via PM2:
#   1. umang-core-platform          (Port 3000 — Consolidated UMANG Core Engine)
#   2. kaposong-rust-control-plane  (Port 8443 -> Tailscale Funnel HTTPS /)
#   3. linka-backend                (Port 3002 -> Tailscale Funnel HTTPS /linka-api)
#   4. linka-aetherwa               (Port 3001 — Co-Hosted AetherWA Gateway)
# ============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${UMANG_DIR:-}" ]]; then
  if [[ -d "${ROOT_DIR}/../Umang" ]]; then
    UMANG_DIR="$(cd "${ROOT_DIR}/../Umang" && pwd)"
  elif [[ -d "${ROOT_DIR}/../Business/Liparola FC/Umang" ]]; then
    UMANG_DIR="$(cd "${ROOT_DIR}/../Business/Liparola FC/Umang" && pwd)"
  else
    UMANG_DIR="/home/aurum/Documents/Projects/Business/Liparola FC/Umang"
  fi
fi

if [[ -z "${LINKA_DIR:-}" ]]; then
  if [[ -d "${ROOT_DIR}/../Linka-Lesotho-2L-" ]]; then
    LINKA_DIR="$(cd "${ROOT_DIR}/../Linka-Lesotho-2L-" && pwd)"
  elif [[ -d "/home/lipserver/Desktop/LINKA" ]]; then
    LINKA_DIR="/home/lipserver/Desktop/LINKA"
  else
    LINKA_DIR=""
  fi
fi

LOG_DIR="${ROOT_DIR}/logs"
mkdir -p "${LOG_DIR}" "${UMANG_DIR}/logs"

if [[ -f "${ROOT_DIR}/.env" ]]; then
  # Read variables locally for preflight summary without exporting ka-posong's
  # PORT=8443 or SQLite DATABASE_URL into UMANG / Linka child processes.
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
fi

# Resolve local PM2 binary
PM2_BIN=""
for candidate in \
  "$(command -v pm2 2>/dev/null || true)" \
  "${HOME}/.local/bin/pm2" \
  "/home/lipserver/services/Linka-Lesotho-2L-/workspace-otp-server/node_modules/.bin/pm2" \
  "/home/lipserver/Desktop/LINKA/workspace-otp-server/node_modules/.bin/pm2" \
  "/home/aurum/.npm/_npx/5f7878ce38f1eb13/node_modules/.bin/pm2" \
  "/home/aurum/Documents/Projects/Business/Liparola FC/ka.sesiung/workspace-otp-server/node_modules/.bin/pm2" \
  "/home/aurum/Documents/Linka-Lesotho-2L-/khauta-stunning-tribble/workspace-otp-server/node_modules/.bin/pm2"
do
  if [[ -n "${candidate}" && -x "${candidate}" ]]; then
    PM2_BIN="${candidate}"
    break
  fi
done

ACTION="${1:-start}"
APP_ENV_LABEL="${APP_ENV:-${NODE_ENV:-development}}"
HOST_BIND="${HOST:-127.0.0.1}"
TARGET_HOSTNAME="${PRIMARY_MAIL_HOSTNAME:-$(hostname -f 2>/dev/null || hostname)}"
CP_PORT="${PORT:-8443}"
UMANG_PORT="${UMANG_PORT:-3000}"

print_preflight() {
  echo "=================================================================="
  echo "🧭 KA-POSONG, LINKA & UMANG CORE PREFLIGHT SUMMARY (NON-SECRET)"
  echo "=================================================================="
  echo "  • Action:                ${ACTION}"
  echo "  • Environment (APP_ENV): ${APP_ENV_LABEL}"
  echo "  • Target Hostname:       ${TARGET_HOSTNAME}"
  echo "  • Loopback Bind Host:    ${HOST_BIND}"
  echo "  • UMANG Core Port:       127.0.0.1:${UMANG_PORT}"
  echo "  • Ka-Posong Port:        ${HOST_BIND}:${CP_PORT} (Funnel: /)"
  echo "  • Linka Backend Port:    127.0.0.1:3002 (Funnel: /linka-api)"
  echo "  • Linka AetherWA Port:   127.0.0.1:3001"
  echo "=================================================================="
}

stop_daemons() {
  echo "🛑 Stopping Ka-Posong / UMANG PM2 processes..."
  if [[ -n "${PM2_BIN}" ]]; then
    "${PM2_BIN}" delete kaposong-umang-otp-bridge kaposong-rust-control-plane umang-core-platform 2>/dev/null || true
    "${PM2_BIN}" stop workspace-otp-server 2>/dev/null || true
  fi
  pkill -f "umang-otp-bridge/src/server.js" 2>/dev/null || true
  pkill -f "target/debug/rust-control-plane" 2>/dev/null || true
  pkill -f "target/release/rust-control-plane" 2>/dev/null || true
  pkill -f "${UMANG_DIR}/src/server.js" 2>/dev/null || true
  sleep 1
}

show_status() {
  echo "=================================================================="
  echo "📊 UMANG CORE, KA-POSONG & LINKA PRODUCTION DAEMON STATUS"
  echo "=================================================================="
  echo -n "• UMANG Core Engine (127.0.0.1:3000):       "
  if curl -sf http://127.0.0.1:3000/api/health | grep -q "umang-core-platform" 2>/dev/null; then
    echo "ONLINE ✅"
    curl -s http://127.0.0.1:3000/api/health
    echo ""
  else
    echo "OFFLINE ❌"
  fi

  echo -n "• ka-posong Control Plane (127.0.0.1:8443): "
  if curl -sf http://127.0.0.1:8443/api/health | grep -q "ka-posong-rust-control-plane" 2>/dev/null; then
    echo "ONLINE ✅"
    curl -s http://127.0.0.1:8443/api/health
    echo ""
  else
    echo "OFFLINE ❌"
  fi

  echo -n "• Linka Backend Connector (127.0.0.1:3002): "
  if curl -sf http://127.0.0.1:3002/api/health | grep -q "linka-workspace-otp-server" 2>/dev/null; then
    echo "ONLINE ✅"
    curl -s http://127.0.0.1:3002/api/health
    echo ""
  else
    echo "OFFLINE ❌"
  fi

  echo -n "• Linka AetherWA Gateway (127.0.0.1:3001):  "
  if curl -sf http://127.0.0.1:3001/api/health | grep -q "linka-aetherwa" 2>/dev/null; then
    echo "ONLINE ✅"
    curl -s http://127.0.0.1:3001/api/health
    echo ""
  else
    echo "OFFLINE ❌"
  fi

  if command -v tailscale >/dev/null 2>&1; then
    echo "• Tailscale Funnel Binding:"
    tailscale funnel status 2>/dev/null | head -n 12 || true
  fi
  echo "=================================================================="
}

print_preflight

if [[ "${ACTION}" == "stop" ]]; then
  stop_daemons
  if [[ -n "${PM2_BIN}" ]]; then
    "${PM2_BIN}" delete linka-backend linka-aetherwa 2>/dev/null || true
  fi
  show_status
  exit 0
elif [[ "${ACTION}" == "status" ]]; then
  show_status
  exit 0
fi

stop_daemons

if [[ -n "${PM2_BIN}" ]]; then
  echo "🚀 [1/3] Starting UMANG Core Platform (:3000) via PM2..."
  "${PM2_BIN}" start "${UMANG_DIR}/ecosystem.config.cjs"

  for _ in $(seq 1 25); do
    if curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done

  echo "🚀 [2/3] Starting ka-posong Rust Control Plane release binary (:8443) via PM2..."
  "${PM2_BIN}" start "${ROOT_DIR}/ecosystem.config.cjs"

  if [[ -n "${LINKA_DIR}" && -f "${LINKA_DIR}/ecosystem.config.cjs" ]]; then
    echo "🚀 [3/3] Starting Linka Backend (:3002) & AetherWA (:3001) via PM2..."
    mkdir -p "${LINKA_DIR}/workspace-otp-server/logs" "${LINKA_DIR}/linka-aetherwa/data/logs"
    "${PM2_BIN}" delete linka-backend linka-aetherwa 2>/dev/null || true
    "${PM2_BIN}" start "${LINKA_DIR}/ecosystem.config.cjs"
  fi

  "${PM2_BIN}" save --force >/dev/null 2>&1 || true
else
  echo "🚀 [1/2] Starting UMANG Core Platform on port 3000..."
  (
    cd "${UMANG_DIR}"
    setsid node --no-warnings src/server.js > "${UMANG_DIR}/logs/umang-core.log" 2>&1 < /dev/null &
  )
  for _ in $(seq 1 25); do
    if curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done

  echo "🚀 [2/2] Starting ka-posong Rust Control Plane release binary on port 8443..."
  (
    cd "${ROOT_DIR}/rust-control-plane"
    setsid "${ROOT_DIR}/rust-control-plane/target/release/rust-control-plane" \
      > "${LOG_DIR}/rust-control-plane.log" 2>&1 < /dev/null &
  )
fi

if command -v tailscale >/dev/null 2>&1; then
  echo "🌐 Configuring Tailscale Funnel (/ -> 127.0.0.1:8443, /linka-api -> 127.0.0.1:3002)..."
  tailscale funnel --bg --https=443 --set-path=/ http://127.0.0.1:8443 >/dev/null 2>&1 || tailscale funnel --bg 8443 >/dev/null 2>&1 || true
  tailscale funnel --bg --https=443 --set-path=/linka-api http://127.0.0.1:3002 >/dev/null 2>&1 || true
fi

sleep 5
show_status
echo "📄 Logs:"
echo "  tail -f ${UMANG_DIR}/logs/umang-core.log"
echo "  tail -f ${LOG_DIR}/rust-control-plane.log"
if [[ -n "${LINKA_DIR}" ]]; then
  echo "  tail -f ${LINKA_DIR}/workspace-otp-server/logs/pm2-out.log"
fi
