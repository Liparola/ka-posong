#!/usr/bin/env bash
# ============================================================================
# KA-POSONG & UMANG AUTH DAEMON MANAGER (scripts/start-umang-daemons.sh)
# ============================================================================
# Starts and manages the two core daemons required by https://liparola.org/umail:
#   1. umang-otp-bridge (Port 3001) — WhatsApp (wwebjs/AetherWA) + Huawei Router SMS (192.168.9.1)
#   2. rust-control-plane (Port 3000 + Tailscale Funnel Port 8443) — UMANG Auth, uMail API & Cloudflare Ingress
# ============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs"
mkdir -p "${LOG_DIR}"

ACTION="${1:-start}"

stop_daemons() {
  echo "🛑 Stopping existing ka-posong / UMANG daemons..."
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
  if curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo "ONLINE ✅"
  else
    echo "OFFLINE ❌"
  fi

  echo -n "• Tailscale Funnel Proxy (127.0.0.1:8443): "
  if curl -sf http://127.0.0.1:8443/api/health >/dev/null 2>&1; then
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

echo "🚀 [1/2] Starting UMANG Multi-Channel OTP Delivery Bridge on port 3001..."
nohup env \
  UMANG_BRIDGE_PORT=3001 \
  ROUTER_IPS="192.168.9.1,192.168.8.1,192.168.10.1" \
  ROUTER_USER="admin" \
  ROUTER_PASS="Technomath" \
  WWEBJS_AUTH_PATH="/home/aurum/Documents/Projects/Business/Liparola FC/ka.sesiung/workspace-otp-server/.wwebjs_auth" \
  node "${ROOT_DIR}/umang-otp-bridge/src/server.js" \
  > "${LOG_DIR}/umang-otp-bridge.log" 2>&1 &

echo "🚀 [2/2] Starting ka-posong Rust Control Plane & UMANG Gateway on ports 3000 & 8443..."
cd "${ROOT_DIR}/rust-control-plane"
nohup env \
  PORT=3000 \
  FUNNEL_PORT=8443 \
  DATABASE_URL="sqlite://${ROOT_DIR}/rust-control-plane/control_plane.db?mode=rwc" \
  UMANG_OTP_BRIDGE_URL="http://127.0.0.1:3001" \
  PRIMARY_MAIL_HOSTNAME="aurum-thinkpad-t440p.tail8fafd0.ts.net" \
  MASTER_DEVOPS_KEY="devops-master-key" \
  BRIDGE_SECRET="cf-tunnel-secret" \
  ALLOW_DEV_OTP_PREVIEW="true" \
  "${ROOT_DIR}/rust-control-plane/target/debug/rust-control-plane" \
  > "${LOG_DIR}/rust-control-plane.log" 2>&1 &

sleep 2
show_status
echo "📄 Logs:"
echo "  tail -f ${LOG_DIR}/umang-otp-bridge.log"
echo "  tail -f ${LOG_DIR}/rust-control-plane.log"
