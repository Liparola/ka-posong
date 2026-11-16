#!/usr/bin/env bash
# ============================================================================
# KA-POSONG <-> UMANG CORE END-TO-END INTEGRATION & HARDENING VERIFIER
# Verifies both Test/Dev E2E Flows and Production Security Hardening Guarantees:
#   1. UMANG Core Engine (:UMANG_PORT) + ka-posong Rust Control Plane (:TEST_PORT)
#   2. Business Tier Quota Enforcement (HTTP 402 Payment Required on limit overflow)
#   3. Tenant-Delegated Phone+OTP Flow (`tnt_ka_posong`) & Single-Use Anti-Replay
#   4. OIDC Discovery, Client SDK Proxy & OAuth 2.0 + PKCE (S256) SSO Exchange
#   5. Bidirectional HMAC-SHA256 Extending Arms Webhooks & Global JTI Revocation
#   6. Cloudflare Email Worker HMAC-Signed RFC822 MIME Tunnel (`/ingest-email`)
#   7. Strict Production Mode Hardening (`ALLOW_DEV_OTP_PREVIEW=false`):
#      - `/ops` 401 gate + HttpOnly cookie login + zero leaked keys in HTML
#      - Zero unauthenticated PII on `/api/v1/domains/:domain/identities`
#      - Zero `dev_otp_preview` / `web_otp_hint` & masked `email_hint`
#      - 5-attempt OTP brute-force lockout (`429 Too Many Requests`)
# ============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UMANG_DIR="/home/aurum/Documents/Projects/Business/Liparola FC/Umang"
cd "$ROOT_DIR"

BIN_PATH="$ROOT_DIR/rust-control-plane/target/release/rust-control-plane"
if [ ! -x "$BIN_PATH" ]; then
    BIN_PATH="$ROOT_DIR/rust-control-plane/target/debug/rust-control-plane"
fi

PORT="${TEST_PORT:-3090}"
UMANG_PORT="${TEST_UMANG_PORT:-3091}"
PROD_PORT="${TEST_PROD_PORT:-3092}"
PROD_UMANG_PORT="${TEST_PROD_UMANG_PORT:-3093}"

MASTER_KEY="devops-test-master-key-2026"
INTERNAL_KEY="umang-test-internal-key-2026"
CF_SECRET="cf-tunnel-hmac-secret-2026"
JWT_SECRET="umang-jwt-test-secret-2026-32bytes"
WEBHOOK_SECRET="whsec_kaposong_umang_arm_2026"
COOKIE_JAR="/tmp/kaposong_ops_cookies_$$.txt"

DB_FILE="/tmp/kaposong_verify_$$.db"
UMANG_DB_FILE="/tmp/umang_verify_$$.db"
PROD_DB_FILE="/tmp/kaposong_prod_verify_$$.db"
PROD_UMANG_DB_FILE="/tmp/umang_prod_verify_$$.db"

CP_PID=""
UMANG_PID=""
PROD_CP_PID=""
PROD_UMANG_PID=""

cleanup() {
    for pid in "$CP_PID" "$UMANG_PID" "$PROD_CP_PID" "$PROD_UMANG_PID"; do
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
        fi
    done
    rm -f "$COOKIE_JAR" \
        "$DB_FILE" "$DB_FILE-shm" "$DB_FILE-wal" \
        "$UMANG_DB_FILE" "$UMANG_DB_FILE-shm" "$UMANG_DB_FILE-wal" \
        "$PROD_DB_FILE" "$PROD_DB_FILE-shm" "$PROD_DB_FILE-wal" \
        "$PROD_UMANG_DB_FILE" "$PROD_UMANG_DB_FILE-shm" "$PROD_UMANG_DB_FILE-wal"
}
trap cleanup EXIT

wait_for_health() {
    local url="$1"
    for _ in $(seq 1 30); do
        if curl -fsS "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.3
    done
    echo "❌ Timed out waiting for $url"
    exit 1
}

echo "============================================================================"
echo "🧬 1. Starting UMANG Core Platform (Test Integration Mode) on :${UMANG_PORT}..."
echo "============================================================================"
(
    cd "$UMANG_DIR"
    NODE_ENV=test \
    ALLOW_DEV_OTP_PREVIEW=true \
    PORT="$UMANG_PORT" \
    HOST="127.0.0.1" \
    UMANG_DB_PATH="$UMANG_DB_FILE" \
    JWT_SECRET="$JWT_SECRET" \
    MASTER_DEVOPS_KEY="$MASTER_KEY" \
    INTERNAL_SECRET="$INTERNAL_KEY" \
    UMANG_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
    ENABLE_WHATSAPP_GATEWAY=false \
    MOCK_SMS=true \
    node --no-warnings src/server.js
) >/tmp/umang_verify_$$.log 2>&1 &
UMANG_PID=$!
wait_for_health "http://127.0.0.1:${UMANG_PORT}/api/health"
curl -fsS "http://127.0.0.1:${UMANG_PORT}/api/health" | grep -q '"status":"ok"'
echo "✅ UMANG Core Engine is ONLINE."

echo "============================================================================"
echo "🦀 2. Starting ka-posong Rust Control Plane (:${PORT} -> UMANG :${UMANG_PORT})..."
echo "============================================================================"
PORT="$PORT" \
SECONDARY_PORT=0 \
ALLOW_DEV_OTP_PREVIEW=true \
DATABASE_URL="sqlite://${DB_FILE}?mode=rwc" \
MASTER_DEVOPS_KEY="$MASTER_KEY" \
BRIDGE_SECRET="$CF_SECRET" \
JWT_SECRET="$JWT_SECRET" \
UMANG_CORE_URL="http://127.0.0.1:${UMANG_PORT}" \
UMANG_TENANT_ID="tnt_ka_posong" \
UMANG_API_KEY="sk_live_ka_posong_umail_2026" \
UMANG_CLIENT_ID="umang_pk_ka_posong" \
UMANG_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
PRIMARY_MAIL_HOSTNAME="aurum-thinkpad-t440p.tail8fafd0.ts.net" \
UMAIL_STATIC_DIR="$ROOT_DIR/umail-web-client/dist" \
"$BIN_PATH" >/tmp/kaposong_verify_$$.log 2>&1 &
CP_PID=$!
wait_for_health "http://127.0.0.1:${PORT}/api/health"
HEALTH=$(curl -fsS "http://127.0.0.1:${PORT}/api/health")
echo "✅ Rust Control Plane Health: $HEALTH"

echo "============================================================================"
echo "🏢 3. Onboarding STARTER Tenant & Verifying HTTP 402 Quota Enforcement..."
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
TENANT_ID=$(echo "$ONBOARD_RESP" | jq -r '.tenant_id')
TENANT_API_KEY=$(echo "$ONBOARD_RESP" | jq -r '.scoped_api_key_for_extending_arms')
echo "✅ Provisioned Tenant ID: ${TENANT_ID}"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${PORT}/api/v1/tenants/${TENANT_ID}/domains" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: ${TENANT_API_KEY}" \
    -d '{"domain_name": "second-domain.co.ls"}')
if [ "$HTTP_CODE" != "402" ]; then
    echo "❌ Expected HTTP 402 on STARTER 2nd domain, got $HTTP_CODE"
    exit 1
fi
echo "✅ STARTER tier secondary domain blocked with HTTP 402 Payment Required."

echo "============================================================================"
echo "📱 4. Testing Delegated UMANG Core OTP Login (karabomilling.co.ls & liparola.org)..."
echo "============================================================================"
OTP_REQ=$(curl -fsS -X POST "http://127.0.0.1:${PORT}/api/auth/request-otp" \
    -H "Content-Type: application/json" \
    -d '{"phone": "53872233", "domain": "karabomilling.co.ls", "channel": "whatsapp"}')
OTP_CODE=$(echo "$OTP_REQ" | jq -r '.dev_otp_preview')
[ "${#OTP_CODE}" -eq 6 ] || { echo "❌ Expected 6-digit OTP"; exit 1; }
echo "✅ Dispatched 6-digit OTP via UMANG Core for info@karabomilling.co.ls: ${OTP_CODE}"

VERIFY_RESP=$(curl -fsS -X POST "http://127.0.0.1:${PORT}/api/auth/verify-otp" \
    -H "Content-Type: application/json" \
    -d "{\"phone\": \"+26653872233\", \"otp\": \"${OTP_CODE}\", \"domain\": \"karabomilling.co.ls\"}")
JWT_TOKEN=$(echo "$VERIFY_RESP" | jq -r '.token')
[ "$(echo "$VERIFY_RESP" | jq -r '.client.email')" = "info@karabomilling.co.ls" ]
echo "✅ Verified OTP and issued 8-Hour UMANG JWT for info@karabomilling.co.ls."

REPLAY_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${PORT}/api/auth/verify-otp" \
    -H "Content-Type: application/json" \
    -d "{\"phone\": \"+26653872233\", \"otp\": \"${OTP_CODE}\", \"domain\": \"karabomilling.co.ls\"}")
[ "$REPLAY_CODE" = "401" ] || { echo "❌ Expected 401 on OTP replay, got $REPLAY_CODE"; exit 1; }
echo "✅ Single-use OTP replay protection verified (HTTP 401)."

echo "============================================================================"
echo "🔐 5. Testing OIDC Discovery, Client SDK Proxy & OAuth2 PKCE S256 SSO Flow..."
echo "============================================================================"
OIDC_CONF=$(curl -fsS "http://127.0.0.1:${PORT}/.well-known/openid-configuration")
grep -q '/api/v1/sso/token' <<<"$OIDC_CONF"
SDK_JS=$(curl -fsS "http://127.0.0.1:${PORT}/sdk/v1/umang.js")
grep -q 'umang.accounts.id' <<<"$SDK_JS"

PKCE_PAIR=$(node -e '
  const crypto = require("crypto");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  console.log(JSON.stringify({ verifier, challenge }));
')
CODE_VERIFIER=$(echo "$PKCE_PAIR" | jq -r '.verifier')
CODE_CHALLENGE=$(echo "$PKCE_PAIR" | jq -r '.challenge')

SSO_OTP_REQ=$(curl -fsS -X POST "http://127.0.0.1:${PORT}/api/v1/instances/tnt_ka_posong/auth/request-otp" \
    -H "Content-Type: application/json" \
    -d '{"phone": "+26663483311", "domain": "karabomilling.co.ls", "mock": true}')
SSO_OTP=$(echo "$SSO_OTP_REQ" | jq -r '.dev_otp_preview')

AUTH_CODE_RESP=$(curl -fsS -X POST "http://127.0.0.1:${PORT}/api/v1/sso/authorize-code" \
    -H "Content-Type: application/json" \
    -H "X-Tenant-ID: tnt_ka_posong" \
    -d "{
      \"phone\": \"+26663483311\",
      \"otp\": \"${SSO_OTP}\",
      \"domain\": \"karabomilling.co.ls\",
      \"client_id\": \"umang_pk_ka_posong\",
      \"redirect_uri\": \"https://karabomilling.co.ls/umail/login\",
      \"code_challenge\": \"${CODE_CHALLENGE}\",
      \"code_challenge_method\": \"S256\",
      \"state\": \"teststate123\"
    }")
AUTH_CODE=$(echo "$AUTH_CODE_RESP" | jq -r '.code')

SSO_EXCHANGE=$(curl -fsS -X POST "http://127.0.0.1:${PORT}/api/auth/sso-exchange" \
    -H "Content-Type: application/json" \
    -d "{
      \"code\": \"${AUTH_CODE}\",
      \"code_verifier\": \"${CODE_VERIFIER}\",
      \"redirect_uri\": \"https://karabomilling.co.ls/umail/login\",
      \"domain\": \"karabomilling.co.ls\"
    }")
SSO_TOKEN=$(echo "$SSO_EXCHANGE" | jq -r '.token')
[ "$(echo "$SSO_EXCHANGE" | jq -r '.client.email')" = "linka@karabomilling.co.ls" ]
echo "✅ OAuth2 PKCE S256 exchanged cleanly for linka@karabomilling.co.ls."

echo "============================================================================"
echo "📡 6. Verifying Bidirectional HMAC Webhooks & Cross-Service Token Revocation..."
echo "============================================================================"
BAD_WEBHOOK_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${PORT}/api/v1/webhooks/umang" \
    -H "Content-Type: application/json" \
    -H "X-Umang-Signature: sha256=deadbeef" \
    -d '{"event_type":"ping","tenant_id":"tnt_ka_posong"}')
[ "$BAD_WEBHOOK_CODE" = "401" ] || { echo "❌ Expected 401 on invalid webhook signature, got $BAD_WEBHOOK_CODE"; exit 1; }

SSO_JTI=$(node -e '
  const p = process.argv[1].split(".")[1];
  console.log(JSON.parse(Buffer.from(p, "base64url").toString()).jti || "");
' "$SSO_TOKEN")
REVOKE_PAYLOAD="{\"event_type\":\"token.revoked\",\"tenant_id\":\"tnt_ka_posong\",\"data\":{\"jti\":\"${SSO_JTI}\"}}"
REVOKE_SIG=$(node -e '
  const crypto = require("crypto");
  console.log("sha256=" + crypto.createHmac("sha256", process.argv[1]).update(process.argv[2]).digest("hex"));
' "$WEBHOOK_SECRET" "$REVOKE_PAYLOAD")

R1=$(curl -fsS -X POST "http://127.0.0.1:${PORT}/api/v1/webhooks/umang" \
    -H "Content-Type: application/json" \
    -H "X-Umang-Signature: ${REVOKE_SIG}" \
    -d "$REVOKE_PAYLOAD")
grep -q '"verified":true' <<<"$R1"

REVOKED_MAIL_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api/umail/messages?folder=inbox" \
    -H "Authorization: Bearer ${SSO_TOKEN}")
[ "$REVOKED_MAIL_CODE" = "401" ] || { echo "❌ Expected 401 after JTI revocation webhook, got $REVOKED_MAIL_CODE"; exit 1; }

# Also test /api/auth/logout on the first session token
R2=$(curl -fsS -X POST "http://127.0.0.1:${PORT}/api/auth/logout" \
    -H "Authorization: Bearer ${JWT_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{}")
grep -q '"revoked":true' <<<"$R2"

LOGOUT_MAIL_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api/umail/messages?folder=inbox" \
    -H "Authorization: Bearer ${JWT_TOKEN}")
[ "$LOGOUT_MAIL_CODE" = "401" ] || { echo "❌ Expected 401 after /api/auth/logout, got $LOGOUT_MAIL_CODE"; exit 1; }
echo "✅ HMAC webhook validation & JTI/logout token revocation verified."

echo "============================================================================"
echo "📨 7. Testing Signed Cloudflare Email Worker RFC822 MIME Ingest & Inbox..."
echo "============================================================================"
# Re-authenticate cleanly for inbox check
OTP_REQ2=$(curl -fsS -X POST "http://127.0.0.1:${PORT}/api/auth/request-otp" \
    -H "Content-Type: application/json" \
    -d '{"phone": "53872233", "domain": "karabomilling.co.ls"}')
OTP_CODE2=$(echo "$OTP_REQ2" | jq -r '.dev_otp_preview')
JWT2=$(curl -fsS -X POST "http://127.0.0.1:${PORT}/api/auth/verify-otp" \
    -H "Content-Type: application/json" \
    -d "{\"phone\": \"+26653872233\", \"otp\": \"${OTP_CODE2}\", \"domain\": \"karabomilling.co.ls\"}" | jq -r '.token')

RAW_MIME=$'From: Grain Buyer <buyer@example.com>\r\nTo: <info@karabomilling.co.ls>\r\nSubject: Maseru Roller Meal Order\r\nAuthentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass\r\n\r\nPlease confirm dispatch of 200 bags.'
MIME_HMAC=$(node -e '
  const crypto = require("crypto");
  console.log(crypto.createHmac("sha256", process.argv[1]).update(process.argv[2], "utf8").digest("hex"));
' "$CF_SECRET" "$RAW_MIME")

INGEST_RESP=$(curl -fsS -X POST "http://127.0.0.1:${PORT}/ingest-email" \
    -H "Content-Type: message/rfc822" \
    -H "X-Bridge-Secret: ${CF_SECRET}" \
    -H "X-Ingress-HMAC-Signature: ${MIME_HMAC}" \
    -H "X-Envelope-From: buyer@example.com" \
    -H "X-Envelope-To: info@karabomilling.co.ls" \
    --data-binary "$RAW_MIME")
grep -q 'INGESTED' <<<"$INGEST_RESP"

INBOX_RESP=$(curl -fsS "http://127.0.0.1:${PORT}/api/umail/messages?folder=inbox" \
    -H "Authorization: Bearer ${JWT2}")
grep -q "Maseru Roller Meal Order" <<<"$INBOX_RESP"
echo "✅ Cloudflare MIME ingest + authenticated karabomilling inbox verified."

echo "============================================================================"
echo "🛡️ 8. Verifying Strict Production Hardening Mode (ALLOW_DEV_OTP_PREVIEW=false)..."
echo "============================================================================"
(
    cd "$UMANG_DIR"
    NODE_ENV=production \
    ALLOW_DEV_OTP_PREVIEW=false \
    PORT="$PROD_UMANG_PORT" \
    HOST="127.0.0.1" \
    UMANG_DB_PATH="$PROD_UMANG_DB_FILE" \
    JWT_SECRET="$JWT_SECRET" \
    MASTER_DEVOPS_KEY="$MASTER_KEY" \
    INTERNAL_SECRET="$INTERNAL_KEY" \
    UMANG_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
    ENABLE_WHATSAPP_GATEWAY=false \
    MOCK_SMS=true \
    node --no-warnings src/server.js
) >/tmp/umang_prod_verify_$$.log 2>&1 &
PROD_UMANG_PID=$!
wait_for_health "http://127.0.0.1:${PROD_UMANG_PORT}/api/health"

PORT="$PROD_PORT" \
SECONDARY_PORT=0 \
ALLOW_DEV_OTP_PREVIEW=false \
DATABASE_URL="sqlite://${PROD_DB_FILE}?mode=rwc" \
MASTER_DEVOPS_KEY="$MASTER_KEY" \
BRIDGE_SECRET="$CF_SECRET" \
JWT_SECRET="$JWT_SECRET" \
UMANG_CORE_URL="http://127.0.0.1:${PROD_UMANG_PORT}" \
UMANG_TENANT_ID="tnt_ka_posong" \
UMANG_API_KEY="sk_live_ka_posong_umail_2026" \
UMANG_CLIENT_ID="umang_pk_ka_posong" \
UMANG_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
PRIMARY_MAIL_HOSTNAME="aurum-thinkpad-t440p.tail8fafd0.ts.net" \
UMAIL_STATIC_DIR="$ROOT_DIR/umail-web-client/dist" \
"$BIN_PATH" >/tmp/kaposong_prod_verify_$$.log 2>&1 &
PROD_CP_PID=$!
wait_for_health "http://127.0.0.1:${PROD_PORT}/api/health"

# 8a. /ops unauthenticated MUST return 401 and contain ZERO secrets
OPS_UNAUTH_CODE=$(curl -s -o /tmp/ops_unauth_$$.html -w "%{http_code}" "http://127.0.0.1:${PROD_PORT}/ops")
[ "$OPS_UNAUTH_CODE" = "401" ] || { echo "❌ Expected 401 on unauth /ops, got $OPS_UNAUTH_CODE"; exit 1; }
! grep -q "$MASTER_KEY" /tmp/ops_unauth_$$.html || { echo "❌ MASTER_KEY leaked on login page"; exit 1; }
rm -f /tmp/ops_unauth_$$.html

UMANG_OPS_UNAUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PROD_UMANG_PORT}/ops")
[ "$UMANG_OPS_UNAUTH_CODE" = "401" ] || { echo "❌ Expected 401 on UMANG /ops in production, got $UMANG_OPS_UNAUTH_CODE"; exit 1; }

# 8b. /ops/login cookie auth -> 200 and zero leaked master key or full raw_api_key
LOGIN_CODE=$(curl -s -o /dev/null -w "%{http_code}" -c "$COOKIE_JAR" -X POST "http://127.0.0.1:${PROD_PORT}/ops/login" \
    -H "Content-Type: application/json" \
    -d "{\"master_key\":\"${MASTER_KEY}\"}")
[ "$LOGIN_CODE" = "200" ] || { echo "❌ Expected 200 on /ops/login, got $LOGIN_CODE"; exit 1; }
OPS_HTML=$(curl -fsS -b "$COOKIE_JAR" "http://127.0.0.1:${PROD_PORT}/ops")
grep -q "Dashboard" <<<"$OPS_HTML"
if grep -q "$MASTER_KEY" <<<"$OPS_HTML"; then
    echo "❌ MASTER_DEVOPS_KEY leaked into authenticated /ops HTML!"
    exit 1
fi

# Also verify UMANG Core /api/webhook-notify enforces HMAC-SHA256 in production
BAD_NOTIFY_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${PROD_UMANG_PORT}/api/webhook-notify" \
    -H "Content-Type: application/json" \
    -d '{"phone":"+26653872233","channel":"sms"}')
[ "$BAD_NOTIFY_CODE" = "401" ] || { echo "❌ Expected 401 on unauth UMANG /api/webhook-notify in prod, got $BAD_NOTIFY_CODE"; exit 1; }

# 8c. Unauthenticated /identities must return empty list; authenticated returns identities
UNAUTH_IDS=$(curl -fsS "http://127.0.0.1:${PROD_PORT}/api/v1/domains/liparola.org/identities" | jq '.identities | length')
[ "$UNAUTH_IDS" = "0" ] || { echo "❌ Unauthenticated /identities leaked $UNAUTH_IDS PII records!"; exit 1; }
AUTH_IDS=$(curl -fsS -H "X-API-Key: ${MASTER_KEY}" "http://127.0.0.1:${PROD_PORT}/api/v1/domains/liparola.org/identities" | jq '.identities | length')
[ "$AUTH_IDS" -ge 3 ] || { echo "❌ Authenticated /identities failed to return liparola.org staff"; exit 1; }

# 8d. /api/auth/request-otp in production must hide dev_otp_preview and mask email_hint
PROD_OTP_RESP=$(curl -fsS -X POST "http://127.0.0.1:${PROD_PORT}/api/auth/request-otp" \
    -H "Content-Type: application/json" \
    -d '{"phone": "53872233", "domain": "karabomilling.co.ls"}')
grep -q '"email_hint":"in\*\*\*@karabomilling.co.ls"' <<<"$PROD_OTP_RESP" || { echo "❌ Expected masked email_hint, got $PROD_OTP_RESP"; exit 1; }
! grep -q 'dev_otp_preview' <<<"$PROD_OTP_RESP" || { echo "❌ dev_otp_preview leaked in production!"; exit 1; }
! grep -q 'web_otp_hint' <<<"$PROD_OTP_RESP" || { echo "❌ web_otp_hint leaked in production!"; exit 1; }

# 8e. Brute-force 5 bad attempts -> 429 lockout
for attempt in 1 2 3 4; do
    BAD_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${PROD_PORT}/api/auth/verify-otp" \
        -H "Content-Type: application/json" \
        -d '{"phone": "53872233", "otp": "000000", "domain": "karabomilling.co.ls"}')
    [ "$BAD_CODE" = "401" ] || { echo "❌ Attempt $attempt expected 401, got $BAD_CODE"; exit 1; }
done
LOCKOUT_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:${PROD_PORT}/api/auth/verify-otp" \
    -H "Content-Type: application/json" \
    -d '{"phone": "53872233", "otp": "000000", "domain": "karabomilling.co.ls"}')
[ "$LOCKOUT_CODE" = "429" ] || { echo "❌ Expected 429 lockout on 5th failure, got $LOCKOUT_CODE"; exit 1; }

echo "✅ Production Hardening Mode verified (401/cookie /ops, zero PII, masked hints, 429 lockout)."
echo "============================================================================"
echo "🎉 ALL KA-POSONG <-> UMANG CORE E2E & HARDENING TESTS PASSED!"
echo "============================================================================"
