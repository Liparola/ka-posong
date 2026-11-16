#!/usr/bin/env bash
# ============================================================================
# KA-POSONG & UMANG CORE DAEMON MANAGER (scripts/start-umang-daemons.sh)
# ============================================================================
# Manages the production-hardened integration stack via PM2:
#   1. umang-core-platform          (Port 3000 — Consolidated UMANG Core Engine)
#   2. kaposong-rust-control-plane  (Port 8443 -> Tailscale Funnel HTTPS)
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
LOG_DIR="${ROOT_DIR}/logs"
mkdir -p "${LOG_DIR}" "${UMANG_DIR}/logs"

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
  set +a
fi

# Resolve local PM2 binary
PM2_BIN=""
for candidate in \
  "$(command -v pm2 2>/dev/null || true)" \
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
  echo "🧭 KA-POSONG & UMANG CORE PREFLIGHT SUMMARY (NON-SECRET)"
  echo "=================================================================="
  echo "  • Action:                ${ACTION}"
  echo "  • Environment (APP_ENV): ${APP_ENV_LABEL}"
  echo "  • Target Mail Hostname:  ${TARGET_HOSTNAME}"
  echo "  • Loopback Bind Host:    ${HOST_BIND}"
  echo "  • UMANG Core Port:       127.0.0.1:${UMANG_PORT}"
  echo "  • Ka-Posong Port:        ${HOST_BIND}:${CP_PORT}"
  echo "  • Co-Hosted Siblings:    linka-backend (:3002) preserved"
  echo "=================================================================="
}

stop_daemons() {
  echo "🛑 Stopping Ka-Posong / UMANG PM2 processes (preserving sibling services such as linka-backend)..."
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
  echo "📊 UMANG CORE & KA-POSONG PRODUCTION DAEMON STATUS"
  echo "=================================================================="
  echo -n "• UMANG Core Engine (127.0.0.1:3000):    "
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

  if command -v tailscale >/dev/null 2>&1; then
    echo "• Tailscale Funnel Binding:"
    tailscale funnel status 2>/dev/null | head -n 8 || true
  fi
  echo "=================================================================="
}

print_preflight

if [[ "${ACTION}" == "stop" ]]; then
  stop_daemons
  show_status
  exit 0
elif [[ "${ACTION}" == "status" ]]; then
  show_status
  exit 0
fi

stop_daemons

if [[ -n "${PM2_BIN}" ]]; then
  echo "🚀 [1/2] Starting UMANG Core Platform (:3000) via PM2..."
  "${PM2_BIN}" start "${UMANG_DIR}/ecosystem.config.cjs"

  for _ in $(seq 1 25); do
    if curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done

  echo "🚀 [2/2] Starting ka-posong Rust Control Plane release binary (:8443) via PM2..."
  "${PM2_BIN}" start "${ROOT_DIR}/ecosystem.config.cjs"
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
  echo "🌐 Ensuring Tailscale Funnel targets 127.0.0.1:8443..."
  tailscale funnel --bg 8443 >/dev/null 2>&1 || true
fi

sleep 2
show_status
echo "📄 Logs:"
echo "  tail -f ${UMANG_DIR}/logs/umang-core.log"
echo "  tail -f ${LOG_DIR}/rust-control-plane.log"
