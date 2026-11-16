#!/usr/bin/env bash
# ============================================================================
# KA-POSONG CLOUDFLARE OUTBOUND SMTPS PROBE
# ============================================================================
set -euo pipefail

CF_TOKEN="${CF_API_TOKEN:-}"
SENDER="${1:-admin@liparola.org}"
RCPT="${2:-${TEST_RECIPIENT_EMAIL:-}}"

if [[ -z "${CF_TOKEN}" ]]; then
  echo "❌ ERROR: CF_API_TOKEN environment variable is required." >&2
  echo "   Export CF_API_TOKEN='<your-cloudflare-email-sending-token>' before running this script." >&2
  exit 1
fi

if [[ -z "${RCPT}" ]]; then
  echo "❌ ERROR: TEST_RECIPIENT_EMAIL environment variable (or 2nd CLI argument) is required." >&2
  echo "   Usage: CF_API_TOKEN=... TEST_RECIPIENT_EMAIL=recipient@example.com $0 [sender@domain]" >&2
  exit 1
fi

echo "=================================================================="
echo "🔍 PROBING CLOUDFLARE SMTPS (PORT 465) FOR DOMAIN: ${SENDER}"
echo "=================================================================="

MAIL_PAYLOAD=$(cat <<EOF
From: ${SENDER}
To: ${RCPT}
Subject: ka-posong Live Outbound Verification
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

This is a test message verifying live Cloudflare outbound delivery from ka-posong.
EOF
)

RESPONSE=$(echo "${MAIL_PAYLOAD}" | curl -v --ssl-reqd \
  --url "smtps://smtp.mx.cloudflare.net:465" \
  --user "api_token:${CF_TOKEN}" \
  --mail-from "${SENDER}" \
  --mail-rcpt "${RCPT}" \
  -T - 2>&1 || true)

if echo "${RESPONSE}" | grep -q "250.*OK\|250.*Accepted\|250 2.0.0"; then
  echo "✅ SUCCESS! Email accepted by Cloudflare SMTPS and dispatched to ${RCPT}."
  echo "The sending domain is ACTIVE."
else
  echo "⚠️ Cloudflare SMTPS conversation log:"
  echo "${RESPONSE}" | grep -E "^< [0-9]{3}|^> [A-Z]{4}|curl:" || echo "${RESPONSE}"
  if echo "${RESPONSE}" | grep -q "550 5.7.1"; then
    echo ""
    echo "👉 Notice: Cloudflare replied '550 5.7.1 Not authorized to send from domain'."
    echo "Click the blue 'Activate' button in your Cloudflare onboarding tab to activate the domain."
  fi
fi
