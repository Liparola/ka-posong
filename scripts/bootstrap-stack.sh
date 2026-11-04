#!/usr/bin/env bash
# ============================================================================
# KA-POSONG STACK BOOTSTRAP & TAILSCALE FUNNEL ORCHESTRATION SCRIPT
# ============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "============================================================================"
echo "🚀 Bootstrapping ka-posong Multi-Tenant Mail Suite & UMANG Identity Engine"
echo "============================================================================"

# 1. Verify required tools
for cmd in cargo node tailscale; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "❌ Missing required dependency: $cmd"
        exit 1
    fi
done

# 2. Initialize .env with cryptographically random secrets if missing
if [ ! -f "$ROOT_DIR/.env" ]; then
    echo "🔐 Generating .env from .env.example with fresh cryptographic secrets..."
    cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
    MASTER_KEY="devops_$(openssl rand -hex 16)"
    BRIDGE_KEY="cf_hmac_$(openssl rand -hex 24)"
    JWT_KEY="umang_jwt_$(openssl rand -hex 24)"
    STALWART_KEY="stalwart_$(openssl rand -hex 16)"

    sed -i "s|MASTER_DEVOPS_KEY=.*|MASTER_DEVOPS_KEY=${MASTER_KEY}|g" "$ROOT_DIR/.env"
    sed -i "s|BRIDGE_SECRET=.*|BRIDGE_SECRET=${BRIDGE_KEY}|g" "$ROOT_DIR/.env"
    sed -i "s|JWT_SECRET=.*|JWT_SECRET=${JWT_KEY}|g" "$ROOT_DIR/.env"
    sed -i "s|STALWART_ADMIN_TOKEN=.*|STALWART_ADMIN_TOKEN=${STALWART_KEY}|g" "$ROOT_DIR/.env"
    echo "✅ Created $ROOT_DIR/.env"
fi

# 3. Build uMail Web Client PWA (Lit + TypeScript)
echo "📦 Building uMail Web Client PWA (/umail)..."
if [ -d "$ROOT_DIR/umail-web-client" ]; then
    (cd "$ROOT_DIR/umail-web-client" && npm run build)
fi

# 4. Build Rust Control Plane
echo "🦀 Compiling Rust Control Plane & UMANG Gateway..."
(cd "$ROOT_DIR/rust-control-plane" && cargo build)

# 5. Check Docker daemon availability or launch standalone native processes
if docker info >/dev/null 2>&1; then
    echo "🐳 Docker daemon accessible — starting full container stack..."
    docker compose up -d --build
else
    echo "ℹ️  Docker socket requires root/group elevation on this host; ready for native or sudo docker compose execution."
    echo "   To launch Tailscale Funnel for public HTTPS ingress:"
    echo "   sudo tailscale funnel --bg --https=443 http://127.0.0.1:3000"
fi

echo "✅ Bootstrap complete!"
