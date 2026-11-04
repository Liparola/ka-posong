#!/usr/bin/env bash
# ============================================================================
# KA-POSONG & UMANG AUTH DAEMON MANAGER (scripts/start-umang-daemons.sh)
# ============================================================================
# Uses PM2 (`ecosystem.config.cjs`) to persistently manage:
#   1. kaposong-umang-otp-bridge (Port 3001)
#   2. kaposong-rust-control-plane (Ports 3000 & 8443 -> Tailscale Funnel)
# ============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs"
mkdir -p "${LOG_DIR}"

# Resolve local PM2 binary
PM2_BIN=""
for candidate in \
  "$(command -v pm2 2>/dev/null || true)" \
  "/home/aurum/Documents/Linka-Lesotho-2L-/khauta-stunning-tribble/workspace-otp-server/node_modules/.bin/pm2" \
  "/home/aurum/Downloads/LINKA/workspace-otp-server/node_modules/.bin/pm2" \
  "/home/aurum/.npm/_npx/5f7878ce38f1eb13/node_modules/.bin/pm2"
do
  if [[ -n "${candidate}" && -x "${candidate}" ]]; then
    PM2_BIN="${candidate}"
    break
  fi
done

ACTION="${1:-start}"

stop_daemons() {
  echo "🛑 Stopping conflicting PM2 / background OTP processes..."
  if [[ -n "${PM2_BIN}" ]]; then
    "${PM2_BIN}" stop linka-backend linka-aetherwa workspace-otp-server 2>/dev/null || true
    "${PM2_BIN}" delete kaposong-umang-otp-bridge kaposong-rust-control-plane 2>/dev/null || true
  fi
  pkill -f "umang-otp-bridge/src/server.js" 2>/dev/null || true
  pkill -f "target/debug/rust-control-plane" 2>/dev/null || true
  sleep 1
}

show_status() {
  echo "=================================================================="
  echo "📊 KA-POSONG & UMANG DAEMON STATUS"
  echo "=================================================================="
  echo -n "• UMANG OTP Bridge (127.0.0.1:3001):      "
  if curl -sf http://127.0.0.1:3001/health >/dev/null 2>&1; then
    echo "ONLINE ✅"
    curl -s http://127.0.0.1:3001/health
    echo ""
  else
    echo "OFFLINE ❌"
  fi

  echo -n "• Rust Control Plane (127.0.0.1:3000):    "
  if curl -sf http://127.0.0.1:3000/api/health | grep -q "ka-posong-rust-control-plane" 2>/dev/null; then
    echo "ONLINE ✅"
  else
    echo "OFFLINE ❌"
  fi

  echo -n "• Tailscale Funnel Proxy (127.0.0.1:8443): "
  if curl -sf http://127.0.0.1:8443/api/health | grep -q "ka-posong-rust-control-plane" 2>/dev/null; then
    echo "ONLINE ✅ (-> https://aurum-thinkpad-t440p.tail8fafd0.ts.net)"
  else
    echo "OFFLINE ❌"
  fi
  echo "=================================================================="
}

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
  echo "🚀 Starting ka-posong daemons persistently via PM2 (ecosystem.config.cjs)..."
  "${PM2_BIN}" start "${ROOT_DIR}/ecosystem.config.cjs"
  "${PM2_BIN}" save --force >/dev/null 2>&1 || true
else
  echo "🚀 [1/2] Starting UMANG Multi-Channel OTP Delivery Bridge on port 3001..."
  setsid env \
    UMANG_BRIDGE_PORT=3001 \
    ROUTER_IPS="192.168.9.1,192.168.8.1,192.168.10.1" \
    ROUTER_USER="admin" \
    ROUTER_PASS="Technomath" \
    WWEBJS_AUTH_PATH="/home/aurum/Documents/Projects/Business/Liparola FC/ka.sesiung/workspace-otp-server/.wwebjs_auth" \
    node "${ROOT_DIR}/umang-otp-bridge/src/server.js" \
    > "${LOG_DIR}/umang-otp-bridge.log" 2>&1 < /dev/null &

  echo "🚀 [2/2] Starting ka-posong Rust Control Plane & UMANG Gateway on ports 8443 & 3000..."
  cd "${ROOT_DIR}/rust-control-plane"
  setsid env \
    PORT=8443 \
    SECONDARY_PORT=3000 \
    DATABASE_URL="sqlite://${ROOT_DIR}/rust-control-plane/control_plane.db?mode=rwc" \
    UMANG_OTP_BRIDGE_URL="http://127.0.0.1:3001" \
    PRIMARY_MAIL_HOSTNAME="aurum-thinkpad-t440p.tail8fafd0.ts.net" \
    MASTER_DEVOPS_KEY="devops-master-key" \
    BRIDGE_SECRET="cf-tunnel-secret" \
    ALLOW_DEV_OTP_PREVIEW="true" \
    "${ROOT_DIR}/rust-control-plane/target/debug/rust-control-plane" \
    > "${LOG_DIR}/rust-control-plane.log" 2>&1 < /dev/null &
fi

sleep 2
show_status
echo "📄 Logs:"
echo "  tail -f ${LOG_DIR}/umang-otp-bridge.log"
echo "  tail -f ${LOG_DIR}/rust-control-plane.log"
