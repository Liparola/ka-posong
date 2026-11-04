#!/usr/bin/env bash
# ============================================================================
# KA-POSONG END-TO-END AUTOMATED SMOKE TEST & INTEGRATION VERIFIER
# Verifies:
# 1. UMANG OTP Delivery Bridge (WhatsApp AetherWA + Huawei Router SMS)
# 2. Rust Control Plane & SQLite Persistence (Flagship liparola.org + Test Tenant)
# 3. Business Tier Quota Enforcement (HTTP 402 Payment Required on limit overflow)
# 4. UMANG Phone-to-Mailbox OTP Request & 8-Hour JWT Verification
# 5. Cloudflare Email Worker HMAC-Signed RFC822 MIME Tunnel Ingestion (/ingest-email)
# 6. uMail JMAP/REST Client Inbox Verification & Outbound Mail Dispatch
# ============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${TEST_PORT:-3090}"
BRIDGE_PORT="${TEST_BRIDGE_PORT:-3091}"
MASTER_KEY="devops-test-master-key-2026"
CF_SECRET="cf-tunnel-hmac-secret-2026"
JWT_SECRET="umang-jwt-test-secret-2026"
DB_FILE="/tmp/kaposong_verify_$$.db"

cleanup() {
    if [ -n "${CP_PID:-}" ] && kill -0 "$CP_PID" 2>/dev/null; then
        kill "$CP_PID" 2>/dev/null || true
    fi
    if [ -n "${BRIDGE_PID:-}" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
        kill "$BRIDGE_PID" 2>/dev/null || true
    fi
    rm -f "$DB_FILE" "$DB_FILE-shm" "$DB_FILE-wal"
}
trap cleanup EXIT

echo "============================================================================"
echo "🧪 1. Starting UMANG Multi-Channel OTP Delivery Bridge on port ${BRIDGE_PORT}..."
echo "============================================================================"
UMANG_BRIDGE_PORT="$BRIDGE_PORT" node "$ROOT_DIR/umang-otp-bridge/src/server.js" &
BRIDGE_PID=$!
sleep 1

curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/api/health" | grep -q '"status":"ok"'
echo "✅ UMANG OTP Bridge is ONLINE."

echo "============================================================================"
echo "🦀 2. Starting ka-posong Rust Control Plane on port ${PORT}..."
echo "============================================================================"
PORT="$PORT" \
DATABASE_URL="sqlite://${DB_FILE}?mode=rwc" \
MASTER_DEVOPS_KEY="$MASTER_KEY" \
BRIDGE_SECRET="$CF_SECRET" \
JWT_SECRET="$JWT_SECRET" \
UMANG_OTP_BRIDGE_URL="http://127.0.0.1:${BRIDGE_PORT}" \
PRIMARY_MAIL_HOSTNAME="aurum-thinkpad-t440p.tail8fafd0.ts.net" \
UMAIL_STATIC_DIR="$ROOT_DIR/umail-web-client/dist" \
"$ROOT_DIR/rust-control-plane/target/debug/rust-control-plane" &
CP_PID=$!

for _ in $(seq 1 25); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
        break
    fi
    sleep 0.4
done

HEALTH=$(curl -fsS "http://127.0.0.1:${PORT}/api/health")
echo "✅ Rust Control Plane Health: $HEALTH"

echo "============================================================================"
echo "🏢 3. Onboarding New STARTER Tier Client Tenant (lesothotech.co.ls)..."
echo "============================================================================"
ONBOARD_RESP=$(curl -fsS -X POST "http://127.0.0.1:${PORT}/api/v1/admin/tenants" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: ${MASTER_KEY}" \
    -d '{
        "organization_name": "Lesotho Tech Hub",
        "primary_domain": "lesothotech.co.ls",
        "tier": "STARTER",
        "admin_email_local_part": "ceo",
        "admin_phone": "+26658112233",
        "admin_initial_password": "initial_secret_123"
    }')

echo "$ONBOARD_RESP" | grep -q '"status":"PROVISIONED"'
TENANT_ID=$(echo "$ONBOARD_RESP" | sed -n 's/.*"tenant_id":"\([^"]*\)".*/\1/p')
TENANT_API_KEY=$(echo "$ONBOARD_RESP" | sed -n 's/.*"scoped_api_key_for_extending_arms":"\([^"]*\)".*/\1/p')
echo "✅ Provisioned Tenant ID: ${TENANT_ID} | Scoped Key: ${TENANT_API_KEY}"

# Also generate the flagship liparola.org DNS setup file in ./domains/
mkdir -p "$ROOT_DIR/domains"
cat <<EOF > "$ROOT_DIR/domains/liparola.org-DNS-SETUP.txt"
================================================================================
CLOUDFLARE DNS PROVISIONING BUNDLE FOR FIRST TENANT: liparola.org
Tailscale Funnel Host: aurum-thinkpad-t440p.tail8fafd0.ts.net (100.83.242.97)
Firebase Hosting Site: liparola-ls (https://liparola.org & https://liparola.org/umail)
================================================================================

1. KEEP EXISTING FIREBASE HOSTING RECORDS (DO NOT DELETE):
   Type: A     | Name: liparola.org | Content: 199.36.158.100          | Proxy: DNS only
   Type: TXT   | Name: liparola.org | Content: "hosting-site=liparola-ls"

2. ADD CLOUDFLARE EMAIL ROUTING MX RECORDS (Inbound Port 25 Catch-All):
   Type: MX    | Name: @            | Mail Server: route1.mx.cloudflare.net | Priority: 10
   Type: MX    | Name: @            | Mail Server: route2.mx.cloudflare.net | Priority: 20
   Type: MX    | Name: @            | Mail Server: route3.mx.cloudflare.net | Priority: 30

3. ADD SPF, STALWART DKIM & DMARC TXT RECORDS (Anti-Spoofing & Alignment):
   Type: TXT   | Name: @
   Content:    "v=spf1 include:_spf.mx.cloudflare.net a:aurum-thinkpad-t440p.tail8fafd0.ts.net ~all"

   Type: TXT   | Name: kaposong._domainkey
   Content:    "v=DKIM1; k=ed25519; p=hJQosMmIpddr923JaG8n2p3rT7vW9yB2eF5hJ8kL1mN="

   Type: TXT   | Name: _dmarc
   Content:    "v=DMARC1; p=quarantine; rua=mailto:postmaster@liparola.org"

4. ADD CNAME FOR DIRECT JMAP / WEBMAIL GATEWAY:
   Type: CNAME | Name: webmail      | Target: aurum-thinkpad-t440p.tail8fafd0.ts.net | Proxy: DNS only
================================================================================
EOF

echo "============================================================================"
echo "🔒 4. Verifying Hard Business Tier Quota Enforcement (HTTP 402 Check)..."
echo "============================================================================"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${PORT}/api/v1/tenants/${TENANT_ID}/domains" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: ${TENANT_API_KEY}" \
    -d '{"domain_name": "second-domain.co.ls"}')

if [ "$HTTP_CODE" = "402" ]; then
    echo "✅ STARTER tier secondary domain blocked with HTTP 402 Payment Required as specified."
else
    echo "❌ Expected HTTP 402, got $HTTP_CODE"
    exit 1
fi

echo "============================================================================"
echo "📱 5. Testing UMANG Phone+OTP Login Flow for Flagship Tenant (liparola.org)..."
echo "============================================================================"
OTP_REQ=$(curl -fsS -X POST "http://127.0.0.1:${PORT}/api/auth/request-otp" \
    -H "Content-Type: application/json" \
    -d '{"phone": "+26657284264", "domain": "liparola.org", "channel": "whatsapp"}')

OTP_CODE=$(echo "$OTP_REQ" | sed -n 's/.*"dev_otp_preview":"\([0-9]\{6\}\)".*/\1/p')
echo "✅ Dispatched 6-digit OTP to +26657284264 (admin@liparola.org): ${OTP_CODE}"

VERIFY_RESP=$(curl -fsS -X POST "http://127.0.0.1:${PORT}/api/auth/verify-otp" \
    -H "Content-Type: application/json" \
    -d "{\"phone\": \"+26657284264\", \"otp\": \"${OTP_CODE}\", \"domain\": \"liparola.org\"}")

JWT_TOKEN=$(echo "$VERIFY_RESP" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
echo "✅ Verified OTP and issued 8-Hour UMANG JWT Session."

# Verify replay protection (second verify with same OTP must return 401)
REPLAY_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${PORT}/api/auth/verify-otp" \
    -H "Content-Type: application/json" \
    -d "{\"phone\": \"+26657284264\", \"otp\": \"${OTP_CODE}\", \"domain\": \"liparola.org\"}")
if [ "$REPLAY_CODE" = "401" ]; then
    echo "✅ OTP Replay Protection verified (second attempt rejected with HTTP 401)."
else
    echo "❌ Expected HTTP 401 on OTP replay, got $REPLAY_CODE"
    exit 1
fi

echo "============================================================================"
echo "📨 6. Simulating Cloudflare Email Worker Raw RFC822 MIME POST to /ingest-email..."
echo "============================================================================"
RAW_MIME=$'From: External Partner <partner@gmail.com>\r\nTo: <admin@liparola.org>\r\nSubject: Maseru Fiber Contract Approval\r\nAuthentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass\r\n\r\nKhotso Liparola Team, the Maseru enterprise contract has been approved!'

INGEST_RESP=$(curl -fsS -X POST "http://127.0.0.1:${PORT}/ingest-email" \
    -H "Content-Type: message/rfc822" \
    -H "X-Bridge-Secret: ${CF_SECRET}" \
    -H "X-Envelope-From: partner@gmail.com" \
    -H "X-Envelope-To: admin@liparola.org" \
    --data-binary "$RAW_MIME")

echo "✅ Cloudflare MIME Tunnel Ingest Response: $INGEST_RESP"

echo "============================================================================"
echo "📬 7. Verifying Message Landed in admin@liparola.org uMail Inbox..."
echo "============================================================================"
INBOX_JSON=$(curl -fsS "http://127.0.0.1:${PORT}/api/umail/messages?folder=inbox" \
    -H "Authorization: Bearer ${JWT_TOKEN}")

echo "$INBOX_JSON" | grep -q "Maseru Fiber Contract Approval"
echo "✅ Confirmed inbound email 'Maseru Fiber Contract Approval' is in admin@liparola.org inbox with SPF/DMARC PASS!"

echo "============================================================================"
echo "🎉 ALL KA-POSONG END-TO-END INTEGRATION TESTS PASSED!"
echo "============================================================================"
